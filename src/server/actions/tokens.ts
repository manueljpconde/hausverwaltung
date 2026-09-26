"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/rbac";
import { generateToken } from "@/lib/api-auth";
import { audit } from "@/lib/audit";
import type { ActionState } from "@/lib/schemas";

/** Row shape mirrored by ApiTokensManager (ISO date strings). */
export type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  userName: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
};

export type TokenState = ActionState & { token?: string; created?: TokenRow };

const schema = z.object({
  name: z.string().trim().min(1),
  userId: z.string().trim().optional().transform((v) => (v ? v : undefined)),
});

export async function createApiToken(_p: TokenState, fd: FormData): Promise<TokenState> {
  const user = await requireUser();
  const r = schema.safeParse(Object.fromEntries(fd));
  if (!r.success) return { error: r.error.issues[0]?.message ?? "Ungültige Eingabe" };

  // Zieluser: standardmäßig man selbst. Für andere → nur ADMIN.
  let targetId = user.id;
  let targetName = user.name ?? user.email ?? "";
  if (r.data.userId && r.data.userId !== user.id) {
    if (user.role !== "ADMIN") return { error: "Nur Administratoren dürfen Token für andere anlegen." };
    const target = await prisma.user.findFirst({
      where: { id: r.data.userId, tenantId: user.tenantId },
      select: { id: true, name: true },
    });
    if (!target) return { error: "Benutzer nicht gefunden" };
    targetId = target.id;
    targetName = target.name;
  }

  const { raw, hash, prefix } = generateToken();
  const row = await prisma.apiToken.create({
    data: { tenantId: user.tenantId, userId: targetId, name: r.data.name, tokenHash: hash, prefix },
  });
  await audit(user, "CREATE", "ApiToken", targetId, r.data.name);

  // Do not revalidatePath here: a layout revalidation remounts settings and wipes
  // useActionState, so the one-time raw token never appears (issue #34). The client
  // merges `created` into the list; revoke/delete still revalidate.
  return {
    ok: true,
    token: raw,
    created: {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      userName: targetName,
      createdAt: row.createdAt.toISOString().slice(0, 10),
      lastUsedAt: null,
      revoked: false,
    },
  };
}

export async function revokeApiToken(fd: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(fd.get("id") ?? "");
  const tok = await prisma.apiToken.findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true, userId: true } });
  if (!tok) return;
  // eigenes Token oder ADMIN
  if (tok.userId !== user.id && user.role !== "ADMIN") return;
  await prisma.apiToken.update({ where: { id: tok.id }, data: { revokedAt: new Date() } });
  await audit(user, "DELETE", "ApiToken", tok.id);
  revalidatePath("/", "layout");
}

// Endgültig entfernen (nur bereits widerrufene Token — aufräumen).
export async function deleteApiToken(fd: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(fd.get("id") ?? "");
  const tok = await prisma.apiToken.findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true, userId: true, revokedAt: true } });
  if (!tok || !tok.revokedAt) return; // nur widerrufene löschen
  if (tok.userId !== user.id && user.role !== "ADMIN") return;
  await prisma.apiToken.delete({ where: { id: tok.id } });
  revalidatePath("/", "layout");
}
