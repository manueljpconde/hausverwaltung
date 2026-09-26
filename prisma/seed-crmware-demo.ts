import { PrismaClient, type UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { simplePdf } from "../src/lib/pdf";

export function resolveDemoAnchor(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
}

export function demoDateFrom(anchor: Date, monthOffset: number, day = 1): Date {
  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + monthOffset, day, 12));
}

export function historicalDemoDateFrom(anchor: Date, monthOffset: number, day = 1): Date {
  const candidate = demoDateFrom(anchor, monthOffset, day);
  return candidate > anchor ? new Date(anchor) : candidate;
}

export const CRMWARE_DEMO_ANCHOR = resolveDemoAnchor();

type DemoSeedEnv = Pick<NodeJS.ProcessEnv, "ALLOW_DEMO_SEED" | "CRMWARE_DEMO_PASSWORD" | "DATABASE_URL" | "NODE_ENV">;

export function assertDemoSeedAllowed(env: Partial<DemoSeedEnv>): string {
  if (env.ALLOW_DEMO_SEED !== "1") throw new Error("Defina ALLOW_DEMO_SEED=1 para autorizar o seed de demonstração.");
  if (env.NODE_ENV === "production") throw new Error("O seed de demonstração é recusado em produção.");
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(env.DATABASE_URL ?? "");
  } catch {
    throw new Error("DATABASE_URL inválido para o seed de demonstração.");
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)) {
    throw new Error("O seed de demonstração só pode usar uma base de dados local.");
  }
  const databaseName = decodeURIComponent(databaseUrl.pathname).replace(/^\//, "");
  if (!/(?:_demo|_test)$/.test(databaseName)) {
    throw new Error("A base de dados local deve ter um nome dedicado terminado em _demo ou _test.");
  }
  const password = env.CRMWARE_DEMO_PASSWORD ?? "";
  if (password.length < 12) throw new Error("CRMWARE_DEMO_PASSWORD deve ter pelo menos 12 caracteres.");
  return password;
}

type ScenarioTargets = {
  internalUsers: number;
  condoProperties: number;
  rentalProperties: number;
  units: number;
  owners: number;
  landlords: number;
  activeLeases: number;
  futureLeases: number;
  terminatedLeases: number;
  delinquentLeases: number;
  availableUnits: number;
  financialMovements: number;
  tickets: number;
  contractors: number;
  meetings: number;
  resolutions: number;
  documents: number;
};

type DemoUnit = { id: string; propertyId: string };
type DemoLease = {
  id: string;
  unitId: string;
  propertyId: string;
  renterPersonId: string;
  startDate: Date;
  endDate: Date | null;
  rentTotal: number;
  state: "terminated" | "active" | "future" | "delinquent";
};
type DemoPayment = { id: string; propertyId: string; amount: number; date: Date; unitId?: string; personId?: string };

export type DemoScenario = {
  key: "mixed" | "condominium" | "rental";
  tenantName: string;
  emailDomain: string;
  targets: ScenarioTargets;
};

export const CRMWARE_DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    key: "mixed",
    tenantName: "CrmWare Demo PT - Gestão Mista",
    emailDomain: "mista.crmware-demo.example",
    targets: {
      internalUsers: 10,
      condoProperties: 5,
      rentalProperties: 20,
      units: 115,
      owners: 90,
      landlords: 7,
      activeLeases: 20,
      futureLeases: 4,
      terminatedLeases: 4,
      delinquentLeases: 3,
      availableUnits: 4,
      financialMovements: 450,
      tickets: 28,
      contractors: 8,
      meetings: 8,
      resolutions: 18,
      documents: 140,
    },
  },
  {
    key: "condominium",
    tenantName: "CrmWare Demo PT - Condomínios",
    emailDomain: "condominios.crmware-demo.example",
    targets: {
      internalUsers: 8,
      condoProperties: 8,
      rentalProperties: 0,
      units: 225,
      owners: 185,
      landlords: 0,
      activeLeases: 0,
      futureLeases: 0,
      terminatedLeases: 0,
      delinquentLeases: 0,
      availableUnits: 0,
      financialMovements: 750,
      tickets: 38,
      contractors: 12,
      meetings: 12,
      resolutions: 30,
      documents: 225,
    },
  },
  {
    key: "rental",
    tenantName: "CrmWare Demo PT - Arrendamento",
    emailDomain: "arrendamento.crmware-demo.example",
    targets: {
      internalUsers: 4,
      condoProperties: 0,
      rentalProperties: 12,
      units: 20,
      owners: 1,
      landlords: 1,
      activeLeases: 14,
      futureLeases: 3,
      terminatedLeases: 5,
      delinquentLeases: 2,
      availableUnits: 3,
      financialMovements: 300,
      tickets: 18,
      contractors: 6,
      meetings: 0,
      resolutions: 0,
      documents: 90,
    },
  },
] as const;

export function demoDate(monthOffset: number, day = 1): Date {
  return demoDateFrom(CRMWARE_DEMO_ANCHOR, monthOffset, day);
}

function historicalDemoDate(monthOffset: number, day = 1): Date {
  return historicalDemoDateFrom(CRMWARE_DEMO_ANCHOR, monthOffset, day);
}

export function validateScenarioDefinitions(scenarios: readonly DemoScenario[]): string[] {
  const errors: string[] = [];
  if (scenarios.length !== 3 || new Set(scenarios.map((s) => s.key)).size !== 3) {
    errors.push("Devem existir exatamente três cenários distintos.");
  }
  for (const scenario of scenarios) {
    const t = scenario.targets;
    if (!scenario.tenantName.startsWith("CrmWare Demo PT - ")) errors.push(`${scenario.key}: nome de tenant inseguro`);
    if (!scenario.emailDomain.endsWith(".example")) errors.push(`${scenario.key}: domínio não reservado`);
    if (t.rentalProperties === 0 && (t.activeLeases || t.futureLeases || t.terminatedLeases)) {
      errors.push(`${scenario.key}: contratos sem imóveis de arrendamento`);
    }
    if (t.condoProperties === 0 && (t.meetings || t.resolutions)) {
      errors.push(`${scenario.key}: assembleias sem condomínios`);
    }
    if (t.activeLeases + t.futureLeases + t.availableUnits > t.units) {
      errors.push(`${scenario.key}: estados atuais excedem as frações`);
    }
    for (const [key, value] of Object.entries(t)) {
      if (!Number.isInteger(value) || value < 0) errors.push(`${scenario.key}: ${key} inválido`);
    }
  }
  return errors;
}

const prisma = new PrismaClient();
const STORAGE = path.join(process.cwd(), "storage", "documents");
const INTERNAL_ROLES: UserRole[] = ["ADMIN", "VERWALTER", "BUCHHALTUNG", "BEIRAT"];
const STREETS = ["Rua do Sol", "Avenida da República", "Rua das Flores", "Praça do Município", "Rua do Mercado", "Alameda dos Oceanos"];
const CITIES = ["Lisboa", "Porto", "Braga", "Coimbra", "Aveiro", "Faro", "Setúbal", "Leiria"];
const FIRST_NAMES = ["Ana", "Beatriz", "Carla", "Diogo", "Eduardo", "Filipa", "Gonçalo", "Helena", "Inês", "João", "Leonor", "Miguel", "Nuno", "Olívia", "Pedro", "Rita", "Sofia", "Tiago", "Vasco"];
const LAST_NAMES = ["Almeida", "Baptista", "Cardoso", "Duarte", "Esteves", "Ferreira", "Gomes", "Henriques", "Lopes", "Martins", "Nunes", "Oliveira", "Pereira", "Ramos", "Silva", "Teixeira"];

function distributed(total: number, buckets: number): number[] {
  if (buckets === 0) return [];
  return Array.from({ length: buckets }, (_, i) => Math.floor(total / buckets) + (i < total % buckets ? 1 : 0));
}

function personName(index: number): { firstName: string; lastName: string } {
  return {
    firstName: FIRST_NAMES[index % FIRST_NAMES.length],
    lastName: `${LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length]} ${index + 1}`,
  };
}

function demoEmail(prefix: string, index: number, domain: string): string {
  return `${prefix}.${String(index + 1).padStart(3, "0")}@${domain}`;
}

function ptIban(seed: number): string {
  return `PT5000020123${String(10000000000 + seed).slice(-11)}58`;
}

export function isValidPtNif(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const sum = digits.slice(0, 8).reduce((total, digit, index) => total + digit * (9 - index), 0);
  const remainder = 11 - (sum % 11);
  const checkDigit = remainder >= 10 ? 0 : remainder;
  return digits[8] === checkDigit;
}

export function invalidPtNif(prefix: 2 | 9, index: number): string {
  const firstEight = `${prefix}${String(10_000_000 + index).slice(-7)}`;
  const validCandidate = `${firstEight}0`;
  const digits = [...validCandidate].map(Number);
  const sum = digits.slice(0, 8).reduce((total, digit, digitIndex) => total + digit * (9 - digitIndex), 0);
  const remainder = 11 - (sum % 11);
  const validCheckDigit = remainder >= 10 ? 0 : remainder;
  return `${firstEight}${(validCheckDigit + 1) % 10}`;
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=", "base64");

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function minimalXlsx(label: string, amount: number): Buffer {
  const files: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Resumo" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${label.replace(/[<>&]/g, "")}</t></is></c><c r="B1"><v>${amount}</v></c></row></sheetData></worksheet>`],
  ];
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

async function assertScenarioTenantOwnership(scenario: DemoScenario) {
  const tenants = await prisma.tenant.findMany({
    where: { name: scenario.tenantName },
    select: { id: true, smtpFrom: true, users: { select: { email: true } } },
  });
  const suffix = `@${scenario.emailDomain}`;
  const marker = `demo-seed@${scenario.emailDomain}`;
  for (const tenant of tenants) {
    if (tenant.smtpFrom !== marker || tenant.users.some((user) => !user.email.endsWith(suffix))) {
      throw new Error(`Colisão de tenant não-demo: ${scenario.tenantName}. Nada foi removido.`);
    }
  }
  return tenants;
}

async function deleteTenantData(tenantId: string): Promise<void> {
  await prisma.$transaction([
    prisma.emailMessage.deleteMany({ where: { tenantId } }),
    prisma.document.deleteMany({ where: { tenantId } }),
    prisma.dunningNotice.deleteMany({ where: { tenantId } }),
    prisma.payment.deleteMany({ where: { tenantId } }),
    prisma.charge.deleteMany({ where: { tenantId } }),
    prisma.deposit.deleteMany({ where: { tenantId } }),
    prisma.account.deleteMany({ where: { tenantId } }),
    prisma.sepaMandate.deleteMany({ where: { tenantId } }),
    prisma.rentAdjustment.deleteMany({ where: { tenantId } }),
    prisma.rentComponent.deleteMany({ where: { tenantId } }),
    prisma.renter.deleteMany({ where: { tenantId } }),
    prisma.lease.deleteMany({ where: { tenantId } }),
    prisma.meterReading.deleteMany({ where: { tenantId } }),
    prisma.meter.deleteMany({ where: { tenantId } }),
    prisma.owner.deleteMany({ where: { tenantId } }),
    prisma.ticket.deleteMany({ where: { tenantId } }),
    prisma.maintenanceContract.deleteMany({ where: { tenantId } }),
    prisma.contractor.deleteMany({ where: { tenantId } }),
    prisma.resolution.deleteMany({ where: { tenantId } }),
    prisma.agendaItem.deleteMany({ where: { tenantId } }),
    prisma.meeting.deleteMany({ where: { tenantId } }),
    prisma.reserveTransaction.deleteMany({ where: { tenantId } }),
    prisma.reserve.deleteMany({ where: { tenantId } }),
    prisma.economicPlan.deleteMany({ where: { tenantId } }),
    prisma.costEntry.deleteMany({ where: { tenantId } }),
    prisma.insurance.deleteMany({ where: { tenantId } }),
    prisma.propertyTax.deleteMany({ where: { tenantId } }),
    prisma.areaAllocation.deleteMany({ where: { tenantId } }),
    prisma.appointment.deleteMany({ where: { tenantId } }),
    prisma.task.deleteMany({ where: { tenantId } }),
    prisma.auditLog.deleteMany({ where: { tenantId } }),
    prisma.notification.deleteMany({ where: { tenantId } }),
    prisma.apiToken.deleteMany({ where: { tenantId } }),
    prisma.bankAuthState.deleteMany({ where: { tenantId } }),
    prisma.bankLink.deleteMany({ where: { tenantId } }),
    prisma.bankConnector.deleteMany({ where: { tenantId } }),
    prisma.user.deleteMany({ where: { tenantId } }),
    prisma.unit.deleteMany({ where: { tenantId } }),
    prisma.building.deleteMany({ where: { tenantId } }),
    prisma.property.deleteMany({ where: { tenantId } }),
    prisma.person.deleteMany({ where: { tenantId } }),
    prisma.customFieldDef.deleteMany({ where: { tenantId } }),
    prisma.importPreset.deleteMany({ where: { tenantId } }),
    prisma.template.deleteMany({ where: { tenantId } }),
    prisma.tenant.delete({ where: { id: tenantId } }),
  ]);
}

async function removeScenarioData(scenario: DemoScenario): Promise<void> {
  const tenants = await assertScenarioTenantOwnership(scenario);
  for (const tenant of tenants) {
    await deleteTenantData(tenant.id);
  }
}

async function cleanStorage(scenario: DemoScenario): Promise<void> {
  await fs.mkdir(STORAGE, { recursive: true });
  for (const file of await fs.readdir(STORAGE)) {
    if (file.startsWith(`crmware-demo-${scenario.key}-`)) await fs.unlink(path.join(STORAGE, file));
  }
}

async function createUsers(tenantId: string, scenario: DemoScenario, passwordHash: string) {
  const roles: UserRole[] = ["ADMIN", "VERWALTER", "VERWALTER", "BUCHHALTUNG", "VERWALTER", "BUCHHALTUNG", "VERWALTER", "BEIRAT", "VERWALTER", "BUCHHALTUNG"];
  const users = [];
  for (let i = 0; i < scenario.targets.internalUsers; i++) {
    users.push(await prisma.user.create({
      data: {
        tenantId,
        email: demoEmail("equipa", i, scenario.emailDomain),
        name: `Equipa ${personName(i).firstName} ${personName(i).lastName}`,
        passwordHash,
        role: roles[i],
        locale: "pt",
      },
    }));
  }
  return users;
}

async function createPeople(tenantId: string, scenario: DemoScenario) {
  const condoOwners = [];
  const condoOwnerCount = scenario.targets.condoProperties ? scenario.targets.owners : 0;
  for (let i = 0; i < condoOwnerCount; i++) {
    const name = personName(i + 20);
    condoOwners.push(await prisma.person.create({
      data: {
        tenantId,
        ...name,
        type: "EIGENTUEMER",
        email: demoEmail("condomino", i, scenario.emailDomain),
        phone: `+351 91${String(1000000 + i).slice(-7)}`,
        note: "Condómino de demonstração",
        custom: { nif: invalidPtNif(2, i) },
      },
    }));
  }
  const landlords = [];
  for (let i = 0; i < scenario.targets.landlords; i++) {
    const name = personName(i + 400);
    landlords.push(await prisma.person.create({
      data: {
        tenantId,
        ...name,
        type: "EIGENTUEMER",
        email: demoEmail("senhorio", i, scenario.emailDomain),
        phone: `+351 96${String(1000000 + i).slice(-7)}`,
        note: "Senhorio de demonstração",
        custom: { nif: invalidPtNif(2, 10_000 + i) },
      },
    }));
  }
  return { condoOwners, landlords };
}

async function createProperties(tenantId: string, scenario: DemoScenario) {
  const condoUnits: DemoUnit[] = [];
  const rentalUnits: DemoUnit[] = [];
  const condoProperties = [];
  const rentalProperties = [];
  const rentalUnitCounts = distributed(
    scenario.targets.activeLeases + scenario.targets.futureLeases + scenario.targets.availableUnits,
    scenario.targets.rentalProperties,
  );
  const condoUnitCounts = distributed(scenario.targets.units - rentalUnitCounts.reduce((a, b) => a + b, 0), scenario.targets.condoProperties);

  for (let i = 0; i < scenario.targets.condoProperties; i++) {
    const unitCount = condoUnitCounts[i];
    const mea = distributed(1000, unitCount);
    const property = await prisma.property.create({
      data: {
        tenantId,
        name: `Condomínio ${["Jardins", "Ribeira", "Atlântico", "Sé", "Boavista", "Mondego", "Ria", "Marina"][i % 8]} ${i + 1}`,
        street: `${STREETS[i % STREETS.length]}, ${10 + i}`,
        zip: `${1000 + i * 137}-${100 + i}`,
        city: CITIES[i % CITIES.length],
        type: "WOHNEN",
        management: "WEG",
        meaTotal: 1000,
        feeType: "PRO_EINHEIT",
        feeValue: 8.5,
        custom: { regime: "propriedade_horizontal", nif: invalidPtNif(9, 20_000 + i) },
      },
    });
    condoProperties.push(property);
    const building = await prisma.building.create({ data: { tenantId, propertyId: property.id, name: "Edifício principal" } });
    for (let j = 0; j < unitCount; j++) {
      const unit = await prisma.unit.create({
        data: {
          tenantId,
          buildingId: building.id,
          label: `Fração ${String.fromCharCode(65 + (j % 26))}${Math.floor(j / 26) || ""}`,
          type: j % 11 === 0 ? "STELLPLATZ" : "WOHNUNG",
          area: j % 11 === 0 ? 13 : 58 + (j % 6) * 9,
          rooms: j % 11 === 0 ? null : 2 + (j % 4),
          mea: mea[j],
          custom: { uso: j % 11 === 0 ? "estacionamento" : "habitação" },
        },
      });
      condoUnits.push({ id: unit.id, propertyId: property.id });
    }
  }

  let rentalUnitIndex = 0;
  for (let i = 0; i < scenario.targets.rentalProperties; i++) {
    const property = await prisma.property.create({
      data: {
        tenantId,
        name: `Imóvel ${["Alfama", "Cedofeita", "Minho", "Baixa", "Foz", "Lapa"][i % 6]} ${i + 1}`,
        street: `${STREETS[(i + 2) % STREETS.length]}, ${30 + i}`,
        zip: `${1100 + i * 83}-${200 + i}`,
        city: CITIES[(i + 1) % CITIES.length],
        type: i % 7 === 0 ? "GEMISCHT" : "WOHNEN",
        management: "MIET",
        feeType: "PROZENT",
        feeValue: 6.5,
        custom: { licença_utilização: `LU-${2020 + (i % 6)}-${100 + i}` },
      },
    });
    rentalProperties.push(property);
    const building = await prisma.building.create({ data: { tenantId, propertyId: property.id, name: "Edifício" } });
    for (let j = 0; j < rentalUnitCounts[i]; j++) {
      const unit = await prisma.unit.create({
        data: {
          tenantId,
          buildingId: building.id,
          label: rentalUnitCounts[i] === 1 ? "Única" : `${j + 1}.º ${j % 2 ? "Dto." : "Esq."}`,
          type: "WOHNUNG",
          area: 48 + (rentalUnitIndex % 8) * 7,
          rooms: 1 + (rentalUnitIndex % 4),
          custom: { certificado_energético: ["A", "B", "B-", "C"][rentalUnitIndex % 4] },
        },
      });
      rentalUnits.push({ id: unit.id, propertyId: property.id });
      rentalUnitIndex++;
    }
  }
  return { condoProperties, rentalProperties, condoUnits, rentalUnits };
}

async function createOwnerships(
  tenantId: string,
  condoUnits: DemoUnit[],
  rentalUnits: DemoUnit[],
  condoOwners: { id: string }[],
  landlords: { id: string }[],
) {
  const condoOwnerships = [];
  for (let i = 0; i < condoUnits.length; i++) {
    condoOwnerships.push(await prisma.owner.create({ data: { tenantId, unitId: condoUnits[i].id, personId: condoOwners[i % condoOwners.length].id, share: 1000 } }));
  }
  for (let i = condoUnits.length; i < condoOwners.length; i++) {
    const ownership = condoOwnerships[(i - condoUnits.length) % condoOwnerships.length];
    await prisma.owner.update({ where: { id: ownership.id }, data: { share: 500 } });
    await prisma.owner.create({ data: { tenantId, unitId: ownership.unitId, personId: condoOwners[i].id, share: 500 } });
  }
  for (let i = 0; i < rentalUnits.length; i++) {
    await prisma.owner.create({ data: { tenantId, unitId: rentalUnits[i].id, personId: landlords[i % landlords.length].id, share: 1000 } });
  }
}

async function createLeases(tenantId: string, scenario: DemoScenario, rentalUnits: DemoUnit[]) {
  const leases: DemoLease[] = [];
  const renters = [];
  for (let i = 0; i < scenario.targets.activeLeases + scenario.targets.futureLeases + scenario.targets.terminatedLeases; i++) {
    const name = personName(i + 700);
    renters.push(await prisma.person.create({
      data: {
        tenantId,
        ...name,
        type: "MIETER",
        email: demoEmail("inquilino", i, scenario.emailDomain),
        phone: `+351 93${String(1000000 + i).slice(-7)}`,
        note: "Inquilino de demonstração",
        custom: { nif: invalidPtNif(2, 30_000 + i) },
      },
    }));
  }

  for (let i = 0; i < scenario.targets.terminatedLeases; i++) {
    const activeStartOffset = -18 + (i % 12);
    const rentCold = 620 + i * 25;
    const component = 45;
    const lease = await prisma.lease.create({
      data: {
        tenantId,
        unitId: rentalUnits[i].id,
        startDate: demoDate(-23 + (i % 5), 1),
        endDate: demoDate(activeStartOffset - 1, 28),
        rentCold,
        personCount: 1 + (i % 3),
        custom: { estado_demo: "terminado" },
        renters: { create: { tenantId, personId: renters[i].id } },
        components: { create: [{ tenantId, type: "STELLPLATZ", amount: component, note: "Lugar de estacionamento contratado" }] },
      },
    });
    leases.push({ id: lease.id, unitId: lease.unitId, propertyId: rentalUnits[i].propertyId, renterPersonId: renters[i].id, startDate: lease.startDate, endDate: lease.endDate, rentTotal: rentCold + component, state: "terminated" });
  }
  for (let i = 0; i < scenario.targets.activeLeases; i++) {
    const rentCold = 680 + (i % 8) * 55;
    const component = 55 + (i % 4) * 10;
    const renter = renters[scenario.targets.terminatedLeases + i];
    const lease = await prisma.lease.create({
      data: {
        tenantId,
        unitId: rentalUnits[i].id,
        startDate: demoDate(-18 + (i % 12), 1),
        rentCold,
        personCount: 1 + (i % 4),
        custom: { estado_demo: i < scenario.targets.delinquentLeases ? "incumprimento" : "ativo" },
        renters: { create: { tenantId, personId: renter.id } },
        components: { create: [{ tenantId, type: "STELLPLATZ", amount: component, note: "Lugar de estacionamento contratado" }] },
        deposit: { create: { tenantId, type: "BAR", amount: 1360 + (i % 8) * 110, receivedDate: demoDate(-18 + (i % 12), 2), note: "Caução contratual" } },
      },
    });
    leases.push({ id: lease.id, unitId: lease.unitId, propertyId: rentalUnits[i].propertyId, renterPersonId: renter.id, startDate: lease.startDate, endDate: null, rentTotal: rentCold + component, state: i < scenario.targets.delinquentLeases ? "delinquent" : "active" });
  }
  for (let i = 0; i < scenario.targets.futureLeases; i++) {
    const rentCold = 790 + i * 45;
    const renter = renters[scenario.targets.terminatedLeases + scenario.targets.activeLeases + i];
    const lease = await prisma.lease.create({
      data: {
        tenantId,
        unitId: rentalUnits[scenario.targets.activeLeases + i].id,
        startDate: demoDate(1 + (i % 2), 1),
        rentCold,
        personCount: 1 + (i % 2),
        custom: { estado_demo: "futuro" },
        renters: { create: { tenantId, personId: renter.id } },
      },
    });
    leases.push({ id: lease.id, unitId: lease.unitId, propertyId: rentalUnits[scenario.targets.activeLeases + i].propertyId, renterPersonId: renter.id, startDate: lease.startDate, endDate: null, rentTotal: rentCold, state: "future" });
  }
  return {
    leases,
    renterPeople: renters,
    activeRenterPeople: renters.slice(
      scenario.targets.terminatedLeases,
      scenario.targets.terminatedLeases + scenario.targets.activeLeases,
    ),
  };
}

async function createPortalUsers(tenantId: string, scenario: DemoScenario, passwordHash: string, people: { condoOwners: { id: string; firstName: string; lastName: string }[]; landlords: { id: string; firstName: string; lastName: string }[]; renterPeople: { id: string; firstName: string; lastName: string }[] }) {
  const users = [];
  for (let i = 0; i < Math.min(3, people.renterPeople.length); i++) {
    const person = people.renterPeople[i];
    users.push(await prisma.user.create({ data: { tenantId, personId: person.id, email: demoEmail("portal.inquilino", i, scenario.emailDomain), name: `${person.firstName} ${person.lastName}`, passwordHash, role: "MIETER", locale: "pt" } }));
  }
  const ownerPeople = [...people.condoOwners.slice(0, 3), ...people.landlords.slice(0, people.condoOwners.length ? 0 : 1)];
  for (let i = 0; i < ownerPeople.length; i++) {
    const person = ownerPeople[i];
    users.push(await prisma.user.create({ data: { tenantId, personId: person.id, email: demoEmail("portal.proprietario", i, scenario.emailDomain), name: `${person.firstName} ${person.lastName}`, passwordHash, role: "EIGENTUEMER", locale: "pt" } }));
  }
  users.push(await prisma.user.create({ data: { tenantId, email: demoEmail("portal.prestador", 0, scenario.emailDomain), name: "Prestador Portal", passwordHash, role: "HANDWERKER", locale: "pt" } }));
  return users;
}

async function peopleByUnit(tenantId: string): Promise<Map<string, string[]>> {
  const units = await prisma.unit.findMany({
    where: { tenantId },
    select: {
      id: true,
      owners: { select: { personId: true } },
      leases: { select: { renters: { select: { personId: true } } } },
    },
  });
  return new Map(units.map((unit) => [
    unit.id,
    [...unit.owners.map((owner) => owner.personId), ...unit.leases.flatMap((lease) => lease.renters.map((renter) => renter.personId))],
  ]));
}

async function createFinance(tenantId: string, scenario: DemoScenario, leases: DemoLease[], condoProperties: { id: string; name: string }[]) {
  const account = await prisma.account.create({ data: { tenantId, name: "Conta de rendas", type: "BANK", iban: ptIban(scenario.key.length) } });
  await prisma.account.create({ data: { tenantId, name: "Cauções", type: "KAUTION", iban: ptIban(scenario.key.length + 30) } });
  const operationalAccount = leases.length && condoProperties.length === 0
    ? await prisma.account.create({ data: { tenantId, name: "Conta operacional", type: "BANK", iban: ptIban(scenario.key.length + 60) } })
    : null;
  const condoAccounts = [];
  for (let i = 0; i < condoProperties.length; i++) {
    condoAccounts.push(await prisma.account.create({ data: { tenantId, name: `Conta - ${condoProperties[i].name}`, type: "BANK", iban: ptIban(100 + i + scenario.key.length) } }));
  }
  const payments: DemoPayment[] = [];
  const delinquentLeases = leases.filter((lease) => lease.state === "delinquent");
  const unpaidPeriod = demoDate(-2, 1);
  const paidLeaseMonths = leases.flatMap((lease) => Array.from({ length: 24 }, (_, index) => {
    const monthOffset = -23 + index;
    const period = demoDate(monthOffset, 1);
    const eligible = lease.state !== "future" && lease.startDate <= period && (!lease.endDate || lease.endDate >= period);
    const reservedForDunning = lease.state === "delinquent" && period.getTime() === unpaidPeriod.getTime();
    return eligible && !reservedForDunning ? [{ lease, monthOffset, period }] : [];
  })).flat();

  if (paidLeaseMonths.length > scenario.targets.financialMovements) {
    throw new Error(`${scenario.key}: o alvo de movimentos não comporta uma cobrança única por contrato e mês`);
  }

  for (let i = 0; i < paidLeaseMonths.length; i++) {
    const { lease, monthOffset, period } = paidLeaseMonths[i];
    const paymentDate = historicalDemoDate(monthOffset, 5 + (i % 3));
    const charge = await prisma.charge.create({
      data: {
        tenantId,
        leaseId: lease.id,
        type: "MIETE",
        period,
        dueDate: demoDate(monthOffset, 8),
        amount: lease.rentTotal,
        description: `Renda ${period.toISOString().slice(0, 7)}`,
        createdAt: period,
      },
    });
    const payment = await prisma.payment.create({
      data: {
        tenantId,
        accountId: account.id,
        chargeId: charge.id,
        date: paymentDate,
        amount: lease.rentTotal,
        direction: "EINGANG",
        reference: `PT-DEMO-${scenario.key.toUpperCase()}-${String(i + 1).padStart(5, "0")}`,
        externalId: `crmware-demo-${scenario.key}-${i + 1}`,
        createdAt: period,
      },
    });
    payments.push({ id: payment.id, propertyId: lease.propertyId, amount: lease.rentTotal, date: paymentDate, unitId: lease.unitId, personId: lease.renterPersonId });
  }

  for (let i = payments.length; i < scenario.targets.financialMovements; i++) {
    const monthOffset = -23 + (i % 24);
    const property = condoProperties.length ? condoProperties[i % condoProperties.length] : null;
    const paymentDate = historicalDemoDate(monthOffset, 5 + (i % 3));
    const amount = 75 + (i % 11) * 12.5;
    const payment = await prisma.payment.create({
      data: {
        tenantId,
        accountId: property ? condoAccounts[i % condoAccounts.length].id : operationalAccount!.id,
        date: paymentDate,
        amount,
        direction: i % 5 === 4 ? "AUSGANG" : "EINGANG",
        reference: `${property ? `Movimento bancário ${property.name}` : "Movimento bancário operacional"} - ${String(i + 1).padStart(5, "0")}`,
        externalId: `crmware-demo-${scenario.key}-${i + 1}`,
        createdAt: historicalDemoDate(monthOffset, 1),
      },
    });
    payments.push({ id: payment.id, propertyId: property?.id ?? leases[i % leases.length].propertyId, amount, date: paymentDate });
  }

  for (let i = 0; i < delinquentLeases.length; i++) {
    const lease = delinquentLeases[i];
    const charge = await prisma.charge.create({ data: { tenantId, leaseId: lease.id, type: "MIETE", period: unpaidPeriod, dueDate: demoDate(-2, 8), amount: lease.rentTotal, description: "Renda vencida para demonstração" } });
    await prisma.dunningNotice.create({ data: { tenantId, chargeId: charge.id, level: i % 2 ? 2 : 1, date: demoDate(-1, 15), fee: 0, note: "Aviso de pagamento" } });
  }
  return payments;
}

async function createOperations(tenantId: string, scenario: DemoScenario, properties: { id: string }[], units: DemoUnit[], leases: DemoLease[], internalUsers: { id: string }[], portalUsers: { id: string; role: UserRole; personId: string | null }[]) {
  const contractors = [];
  const trades = ["Canalização", "Eletricidade", "Elevadores", "Limpeza", "Jardinagem", "Construção civil"];
  for (let i = 0; i < scenario.targets.contractors; i++) {
    contractors.push(await prisma.contractor.create({ data: { tenantId, name: `${trades[i % trades.length]} Lusitana ${i + 1}, Lda.`, trade: trades[i % trades.length], email: demoEmail("prestador", i, scenario.emailDomain), phone: `+351 21${String(1000000 + i).slice(-7)}` } }));
  }
  const reporters = portalUsers.filter((user) => user.role === "MIETER");
  const reporterUnits = reporters.flatMap((reporter) => reporter.personId
    ? leases.filter((lease) => lease.renterPersonId === reporter.personId).map((lease) => ({
        reporter,
        lease,
        unit: units.find((unit) => unit.id === lease.unitId)!,
      }))
    : []);
  const ticketTitles = ["Infiltração na parede", "Luz comum avariada", "Ruído no elevador", "Torneira com fuga", "Portão não fecha", "Pedido de inspeção"];
  for (let i = 0; i < scenario.targets.tickets; i++) {
    const completed = i < Math.floor(scenario.targets.tickets * 0.75);
    const exceptional = i >= Math.ceil(scenario.targets.tickets * 0.92);
    const reporterUnit = reporterUnits[i % Math.max(1, reporterUnits.length)];
    const unit = i < reporterUnits.length ? reporterUnit.unit : units[i % units.length];
    const reporter = i < reporterUnits.length ? reporterUnit.reporter : undefined;
    const generatedCreatedAt = historicalDemoDate(-23 + (i % 24), 3 + (i % 20));
    const createdAt = i < reporterUnits.length && reporterUnit.lease.startDate > generatedCreatedAt
      ? reporterUnit.lease.startDate
      : generatedCreatedAt;
    await prisma.ticket.create({
      data: {
        tenantId,
        propertyId: unit.propertyId,
        unitId: unit.id,
        contractorId: contractors[i % contractors.length].id,
        assigneeId: internalUsers[1 + (i % Math.max(1, internalUsers.length - 1))].id,
        reporterId: reporter?.id ?? null,
        title: `${ticketTitles[i % ticketTitles.length]} #${i + 1}`,
        description: "Ocorrência sintética para demonstração do fluxo operacional.",
        category: i % 3 === 0 ? "SCHADEN" : i % 3 === 1 ? "STOERUNG" : "WARTUNG",
        status: completed ? "ERLEDIGT" : i % 2 ? "IN_ARBEIT" : "WARTEND",
        priority: exceptional ? "HOCH" : i % 4 === 0 ? "NIEDRIG" : "MITTEL",
        dueDate: demoDate(-2 + (i % 5), 10),
        reminderDate: completed ? null : demoDate(0, 28),
        timeSpentMin: completed ? 30 + (i % 8) * 15 : i % 3 * 20,
        createdAt,
      },
    });
  }
  for (let i = 0; i < Math.min(properties.length, contractors.length); i++) {
    await prisma.maintenanceContract.create({ data: { tenantId, propertyId: properties[i].id, contractorId: contractors[i].id, title: `Manutenção preventiva - ${trades[i % trades.length]}`, intervalMonths: i % 2 ? 12 : 6, nextDue: demoDate(i % 3, 15), note: "Contrato de demonstração" } });
  }
  return contractors;
}

async function createCondominium(tenantId: string, scenario: DemoScenario, properties: { id: string }[]) {
  const unitCounts = new Map(await Promise.all(properties.map(async (property) => [
    property.id,
    await prisma.unit.count({ where: { tenantId, building: { propertyId: property.id } } }),
  ] as const)));
  const currentYear = CRMWARE_DEMO_ANCHOR.getUTCFullYear();
  for (let i = 0; i < properties.length; i++) {
    await prisma.economicPlan.create({ data: { tenantId, propertyId: properties[i].id, year: currentYear, totalAmount: 24000 + i * 3750, note: "Orçamento anual aprovado" } });
    const reserve = await prisma.reserve.create({ data: { tenantId, propertyId: properties[i].id, name: "Fundo comum de reserva" } });
    for (let month = -23; month <= 0; month += 3) {
      await prisma.reserveTransaction.create({ data: { tenantId, reserveId: reserve.id, date: historicalDemoDate(month, 25), amount: 900 + i * 60, note: "Dotação trimestral" } });
    }
    await prisma.costEntry.createMany({ data: [
      { tenantId, propertyId: properties[i].id, year: currentYear - 1, type: "VERSICHERUNG", amount: 3200 + i * 200, method: "MEA", note: "Seguro multirriscos" },
      { tenantId, propertyId: properties[i].id, year: currentYear - 1, type: "GEBAEUDEREINIGUNG", amount: 4800 + i * 250, method: "MEA", note: "Limpeza de partes comuns" },
      { tenantId, propertyId: properties[i].id, year: currentYear - 1, type: "SONSTIGE", amount: 1500 + i * 100, method: "MEA", note: "Manutenção corrente" },
    ] });
  }
  const meetings = [];
  const completedCount = Math.floor(scenario.targets.meetings * 0.75);
  for (let i = 0; i < scenario.targets.meetings; i++) {
    const property = properties[i % properties.length];
    const completed = i < completedCount;
    const date = completed ? demoDate(-18 + i * 2, 20) : demoDate(1 + (i - completedCount), 20);
    meetings.push(await prisma.meeting.create({
      data: {
        tenantId,
        propertyId: property.id,
        title: `${i < properties.length ? "Assembleia ordinária" : "Assembleia extraordinária"} ${date.getUTCFullYear()}`,
        date,
        location: "Sala de reuniões da administração",
        status: completed ? "DURCHGEFUEHRT" : "GEPLANT",
        protocol: completed ? "Ata sintética aprovada para demonstração." : null,
        agendaItems: { create: [
          { tenantId, position: 1, title: "Aprovação de contas" },
          { tenantId, position: 2, title: "Orçamento e quotas" },
          { tenantId, position: 3, title: "Obras e manutenção" },
        ] },
      },
    }));
  }
  const completedMeetings = meetings.filter((meeting) => meeting.status === "DURCHGEFUEHRT");
  const nextNumber = new Map<string, number>();
  for (let i = 0; i < scenario.targets.resolutions; i++) {
    const meeting = completedMeetings[i % completedMeetings.length];
    const number = (nextNumber.get(meeting.propertyId) ?? 0) + 1;
    nextNumber.set(meeting.propertyId, number);
    const eligibleVotes = unitCounts.get(meeting.propertyId) ?? 0;
    const adjourned = i % 10 === 9;
    const rejected = i % 10 === 8;
    const votesYes = adjourned ? 0 : rejected ? Math.floor(eligibleVotes / 3) : Math.max(1, eligibleVotes - 4 - (i % 3));
    const votesNo = adjourned ? 0 : rejected ? Math.floor(eligibleVotes / 2) : 1 + (i % 2);
    const votesAbstain = adjourned ? 0 : Math.max(0, eligibleVotes - votesYes - votesNo - (i % 2));
    const result = adjourned ? "VERTAGT" : votesYes > votesNo ? "ANGENOMMEN" : "ABGELEHNT";
    await prisma.resolution.create({ data: { tenantId, propertyId: meeting.propertyId, meetingId: meeting.id, number, title: ["Aprovação de contas", "Reparação da cobertura", "Atualização de quotas"][i % 3], text: "Deliberação sintética para demonstração funcional.", date: meeting.date, result, votesYes, votesNo, votesAbstain } });
  }
}

async function createDocuments(tenantId: string, scenario: DemoScenario, units: DemoUnit[], unitPeople: Map<string, string[]>, payments: DemoPayment[]) {
  const documents = [];
  for (let i = 0; i < scenario.targets.documents; i++) {
    const format = i % 10 < 6 ? "pdf" : i % 10 < 8 ? "png" : i % 10 === 8 ? "jpg" : "xlsx";
    const category = i % 6 === 0 ? "VERTRAG" : i % 6 === 1 ? "RECHNUNG" : i % 6 === 2 ? "PROTOKOLL" : i % 6 === 3 ? "ABRECHNUNG" : "SONSTIGES";
    const invoiceIndex = Math.floor(i / 6);
    const linkedPayment = category === "RECHNUNG" && invoiceIndex < Math.min(payments.length, 40) ? payments[invoiceIndex] : null;
    const documentDate = linkedPayment?.date ?? historicalDemoDate(-23 + (i % 24), 12);
    const amount = linkedPayment?.amount ?? 100 + i * 7.25;
    const buffer = format === "pdf"
      ? simplePdf("Documento de demonstração CrmWare", [`Cenário: ${scenario.tenantName}`, `Referência: ${String(i + 1).padStart(4, "0")}`, `Data: ${documentDate.toISOString().slice(0, 10)}`, `Valor indicativo: ${amount.toFixed(2)} EUR`, "Dados integralmente sintéticos."])
      : format === "png" ? PNG
      : format === "jpg" ? JPEG
      : minimalXlsx(`Mapa ${i + 1}`, amount);
    const storageKey = `crmware-demo-${scenario.key}-${String(i + 1).padStart(4, "0")}.${format}`;
    await fs.writeFile(path.join(STORAGE, storageKey), buffer);
    const mime = format === "pdf" ? "application/pdf" : format === "png" ? "image/png" : format === "jpg" ? "image/jpeg" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const unit = linkedPayment?.unitId
      ? units.find((candidate) => candidate.id === linkedPayment.unitId)!
      : linkedPayment
        ? units.find((candidate) => candidate.propertyId === linkedPayment.propertyId) ?? units[i % units.length]
        : units[i % units.length];
    const relatedPeople = unitPeople.get(unit.id) ?? [];
    const personId = linkedPayment?.personId && relatedPeople.includes(linkedPayment.personId)
      ? linkedPayment.personId
      : relatedPeople[i % Math.max(1, relatedPeople.length)] ?? null;
    const document = await prisma.document.create({ data: { tenantId, propertyId: unit.propertyId, unitId: unit.id, personId, name: `${["Contrato", "Fatura", "Ata", "Mapa", "Comprovativo"][i % 5]} ${String(i + 1).padStart(4, "0")}.${format}`, category, mime, size: buffer.length, storageKey, invoiceNo: category === "RECHNUNG" ? `FT DEMO/${documentDate.getUTCFullYear()}/${String(i + 1).padStart(4, "0")}` : null, invoiceTotal: category === "RECHNUNG" ? amount : null, createdAt: documentDate } });
    documents.push(document);
    if (linkedPayment) {
      await prisma.payment.update({ where: { id: linkedPayment.id }, data: { documents: { connect: { id: document.id } } } });
    }
  }
  return documents;
}

async function createSupportingData(tenantId: string, scenario: DemoScenario, properties: { id: string }[], users: { id: string; name: string }[]) {
  for (let i = 0; i < 18; i++) {
    await prisma.task.create({ data: { tenantId, title: ["Rever valores em aberto", "Preparar assembleia", "Confirmar intervenção", "Atualizar documentação"][i % 4], dueDate: demoDate(-5 + (i % 8), 5 + (i % 20)), done: i < 13, createdAt: historicalDemoDate(-23 + (i % 24), 4) } });
  }
  for (let i = 0; i < 16; i++) {
    await prisma.appointment.create({ data: { tenantId, propertyId: properties[i % properties.length].id, title: ["Visita técnica", "Reunião de acompanhamento", "Inspeção periódica", "Prazo contratual"][i % 4], type: i % 4 === 0 ? "BESICHTIGUNG" : i % 4 === 1 ? "VERSAMMLUNG" : i % 4 === 2 ? "WARTUNG" : "FRIST", start: demoDate(-11 + (i % 14), 8 + (i % 18)), location: CITIES[i % CITIES.length], createdAt: historicalDemoDate(-12 + (i % 12), 2) } });
  }
  for (let i = 0; i < users.length; i++) {
    await prisma.notification.create({ data: { tenantId, userId: users[i].id, title: "Atualização da demonstração", body: `Dados do cenário ${scenario.key} preparados.`, link: "/", read: i % 3 === 0, createdAt: historicalDemoDate(0, 20 + (i % 6)) } });
  }
  for (let i = 0; i < 30; i++) {
    await prisma.auditLog.create({ data: { tenantId, userId: users[i % users.length].id, userName: users[i % users.length].name, action: i % 8 === 7 ? "UPDATE" : "CREATE", entity: ["Property", "Lease", "Ticket", "Document"][i % 4], summary: `Operação sintética ${i + 1}`, createdAt: historicalDemoDate(-23 + (i % 24), 6 + (i % 20)) } });
  }
}

async function seedScenario(scenario: DemoScenario, passwordHash: string): Promise<void> {
  await removeScenarioData(scenario);
  await cleanStorage(scenario);
  const tenant = await prisma.tenant.create({ data: { name: scenario.tenantName, market: "PT", isDemo: false, brandColor: "#53959c", smtpFrom: `demo-seed@${scenario.emailDomain}` } });
  try {
    const internalUsers = await createUsers(tenant.id, scenario, passwordHash);
    const { condoOwners, landlords } = await createPeople(tenant.id, scenario);
    const { condoProperties, rentalProperties, condoUnits, rentalUnits } = await createProperties(tenant.id, scenario);
    await createOwnerships(tenant.id, condoUnits, rentalUnits, condoOwners, landlords);
    const { leases, activeRenterPeople } = await createLeases(tenant.id, scenario, rentalUnits);
    const portalUsers = await createPortalUsers(tenant.id, scenario, passwordHash, { condoOwners, landlords, renterPeople: activeRenterPeople });
    const payments = await createFinance(tenant.id, scenario, leases, condoProperties);
    const allProperties = [...condoProperties, ...rentalProperties];
    const allUnits = [...condoUnits, ...rentalUnits];
    const unitPeople = await peopleByUnit(tenant.id);
    await createOperations(tenant.id, scenario, allProperties, allUnits, leases, internalUsers, portalUsers);
    await createCondominium(tenant.id, scenario, condoProperties);
    await createDocuments(tenant.id, scenario, allUnits, unitPeople, payments);
    await createSupportingData(tenant.id, scenario, allProperties, internalUsers);
  } catch (error) {
    await deleteTenantData(tenant.id);
    await cleanStorage(scenario);
    throw error;
  }
}

type ValidationRow = { scenario: string; errors: string[]; counts: Record<string, number> };

export async function validateSeededScenarios(client: PrismaClient = prisma): Promise<ValidationRow[]> {
  const rows: ValidationRow[] = [];
  for (const scenario of CRMWARE_DEMO_SCENARIOS) {
    const suffix = `@${scenario.emailDomain}`;
    const candidates = await client.tenant.findMany({
      where: { name: scenario.tenantName },
      select: { id: true, isDemo: true, dateFormat: true, smtpFrom: true, users: { select: { email: true } } },
    });
    const managed = candidates.filter((candidate) =>
      candidate.smtpFrom === `demo-seed@${scenario.emailDomain}`
      && candidate.users.length > 0
      && candidate.users.every((user) => user.email.endsWith(suffix)),
    );
    if (managed.length !== 1) {
      rows.push({ scenario: scenario.key, errors: [`esperado 1 tenant de demo identificado, obtidos ${managed.length}`], counts: {} });
      continue;
    }
    const tenant = managed[0];
    const tenantId = tenant.id;
    const [internalUsers, condoProperties, rentalProperties, units, payments, tickets, contractors, meetings, resolutions, documents, leases, landlordCount, condoOwnerCount, rentalUnitRows, relationRows, documentRows, ticketRows, portalUsers, meetingRows, chargeRows, personRows, propertyRows, condoOwnerRows, condoAccounts, rentAccounts] = await Promise.all([
      client.user.count({ where: { tenantId, role: { in: INTERNAL_ROLES } } }),
      client.property.count({ where: { tenantId, management: "WEG" } }),
      client.property.count({ where: { tenantId, management: "MIET" } }),
      client.unit.count({ where: { tenantId } }),
      client.payment.count({ where: { tenantId } }),
      client.ticket.count({ where: { tenantId } }),
      client.contractor.count({ where: { tenantId } }),
      client.meeting.count({ where: { tenantId } }),
      client.resolution.count({ where: { tenantId } }),
      client.document.count({ where: { tenantId } }),
      client.lease.findMany({ where: { tenantId }, select: { id: true, startDate: true, endDate: true, unitId: true, custom: true } }),
      client.person.count({ where: { tenantId, type: "EIGENTUEMER", note: { startsWith: "Senhorio" } } }),
      client.person.count({ where: { tenantId, type: "EIGENTUEMER", note: { startsWith: "Condómino" } } }),
      client.unit.findMany({ where: { tenantId, building: { property: { management: "MIET" } } }, select: { leases: { select: { startDate: true, endDate: true } } } }),
      client.unit.findMany({ where: { tenantId }, select: { tenantId: true, building: { select: { tenantId: true, property: { select: { tenantId: true } } } }, leases: { select: { tenantId: true } }, owners: { select: { tenantId: true, person: { select: { tenantId: true } } } } } }),
      client.document.findMany({ where: { tenantId }, select: { storageKey: true, size: true, propertyId: true, unitId: true, personId: true, invoiceTotal: true, createdAt: true, payments: { select: { amount: true, date: true } }, unit: { select: { building: { select: { propertyId: true } } } }, person: { select: { owners: { select: { unitId: true } }, renters: { select: { lease: { select: { unitId: true } } } } } } } }),
      client.ticket.findMany({ where: { tenantId }, select: { propertyId: true, unitId: true, createdAt: true, unit: { select: { building: { select: { propertyId: true } }, leases: { select: { startDate: true, endDate: true, renters: { select: { personId: true } } } } } }, reporter: { select: { personId: true } } } }),
      client.user.findMany({ where: { tenantId, role: "MIETER" }, select: { email: true, person: { select: { renters: { select: { lease: { select: { startDate: true, endDate: true, charges: { select: { id: true } } } } } } } } } }),
      client.meeting.findMany({ where: { tenantId }, select: { id: true, propertyId: true, date: true, status: true, protocol: true, property: { select: { buildings: { select: { units: { select: { id: true } } } } } }, resolutions: { select: { propertyId: true, number: true, result: true, votesYes: true, votesNo: true, votesAbstain: true } } } }),
      client.charge.findMany({ where: { tenantId }, select: { id: true, leaseId: true, type: true, period: true, amount: true, lease: { select: { startDate: true, endDate: true, rentCold: true, components: { select: { amount: true } } } }, payments: { select: { amount: true } }, dunnings: { select: { id: true } } } }),
      client.person.findMany({ where: { tenantId }, select: { custom: true } }),
      client.property.findMany({ where: { tenantId }, select: { custom: true } }),
      client.person.findMany({ where: { tenantId, note: { startsWith: "Condómino" } }, select: { id: true, owners: { select: { id: true } } } }),
      client.account.findMany({ where: { tenantId, name: { startsWith: "Conta - " } }, select: { name: true, payments: { select: { id: true } } } }),
      client.account.findMany({ where: { tenantId, name: "Conta de rendas" }, select: { payments: { select: { chargeId: true } } } }),
    ]);
    const active = leases.filter((lease) => lease.startDate <= CRMWARE_DEMO_ANCHOR && (!lease.endDate || lease.endDate >= CRMWARE_DEMO_ANCHOR)).length;
    const future = leases.filter((lease) => lease.startDate > CRMWARE_DEMO_ANCHOR).length;
    const terminated = leases.filter((lease) => lease.endDate && lease.endDate < CRMWARE_DEMO_ANCHOR).length;
    const delinquent = leases.filter((lease) => typeof lease.custom === "object" && lease.custom !== null && !Array.isArray(lease.custom) && (lease.custom as Record<string, unknown>).estado_demo === "incumprimento").length;
    const availableUnits = rentalUnitRows.filter((unit) => !unit.leases.some((lease) => !lease.endDate || lease.endDate >= CRMWARE_DEMO_ANCHOR)).length;
    const owners = scenario.targets.condoProperties ? condoOwnerCount : landlordCount;
    const counts = { internalUsers, condoProperties, rentalProperties, units, owners, financialMovements: payments, tickets, contractors, meetings, resolutions, documents, activeLeases: active, futureLeases: future, terminatedLeases: terminated, delinquentLeases: delinquent, availableUnits, landlords: landlordCount };
    const errors = Object.entries(counts).flatMap(([key, actual]) => {
      const expected = scenario.targets[key as keyof ScenarioTargets];
      return expected !== undefined && actual !== expected ? [`${key}: esperado ${expected}, obtido ${actual}`] : [];
    });
    if (tenant.isDemo) errors.push("tenant não pode usar isDemo porque altera landing/login globais");
    if (tenant.dateFormat) errors.push(`dateFormat deve herdar pt, obtido ${tenant.dateFormat}`);
    const [oldest, newest] = await Promise.all([
      client.payment.findFirst({ where: { tenantId }, orderBy: { date: "asc" }, select: { date: true } }),
      client.payment.findFirst({ where: { tenantId }, orderBy: { date: "desc" }, select: { date: true } }),
    ]);
    if (payments && (oldest?.date.getTime() !== demoDate(-23, 5).getTime() || !newest || newest.date < historicalDemoDate(0, 5))) errors.push("histórico financeiro não cobre os 24 meses definidos");
    const futureDatedCounts = await Promise.all([
      client.payment.count({ where: { tenantId, date: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client.ticket.count({ where: { tenantId, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client.document.count({ where: { tenantId, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client.notification.count({ where: { tenantId, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client.auditLog.count({ where: { tenantId, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client.reserveTransaction.count({ where: { tenantId, date: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client.task.count({ where: { tenantId, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client.appointment.count({ where: { tenantId, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
    ]);
    if (futureDatedCounts.some(Boolean)) errors.push(`data futura em registo histórico: ${futureDatedCounts.join(",")}`);

    const leasesByUnit = new Map<string, typeof leases>();
    for (const lease of leases) leasesByUnit.set(lease.unitId, [...(leasesByUnit.get(lease.unitId) ?? []), lease]);
    for (const [unitId, unitLeases] of leasesByUnit) {
      const sorted = [...unitLeases].sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
      for (let i = 1; i < sorted.length; i++) {
        if (!sorted[i - 1].endDate || sorted[i].startDate <= sorted[i - 1].endDate!) {
          errors.push(`contratos sobrepostos na fração ${unitId}`);
        }
      }
    }

    for (const charge of chargeRows) {
      if (charge.type === "HAUSGELD" && !charge.lease) errors.push("quota de condomínio sem relação estrutural");
      if (!charge.lease) continue;
      if (charge.period < charge.lease.startDate || (charge.lease.endDate && charge.period > charge.lease.endDate)) {
        errors.push(`cobrança fora da vigência: ${charge.period.toISOString()}`);
      }
      const expected = Number(charge.lease.rentCold) + charge.lease.components.reduce((sum, component) => sum + Number(component.amount), 0);
      if (Math.abs(Number(charge.amount) - expected) > 0.001) errors.push(`renda divergente: esperado ${expected}, obtido ${charge.amount}`);
      if (charge.payments.some((payment) => Math.abs(Number(payment.amount) - Number(charge.amount)) > 0.001)) {
        errors.push("pagamento divergente da cobrança");
      }
      if (charge.dunnings.length && charge.payments.length) errors.push(`cobrança em aviso já paga: ${charge.id}`);
    }
    const chargeMonthCounts = new Map<string, number>();
    for (const charge of chargeRows) {
      if (!charge.leaseId) continue;
      const key = `${charge.leaseId}:${charge.period.toISOString().slice(0, 7)}`;
      chargeMonthCounts.set(key, (chargeMonthCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of chargeMonthCounts) {
      if (count !== 1) errors.push(`mês de contrato cobrado ${count} vezes: ${key}`);
    }
    for (const lease of leases) {
      for (let offset = -23; offset <= 0; offset++) {
        const period = demoDate(offset, 1);
        if (lease.startDate <= period && (!lease.endDate || lease.endDate >= period)) {
          const key = `${lease.id}:${period.toISOString().slice(0, 7)}`;
          if ((chargeMonthCounts.get(key) ?? 0) !== 1) errors.push(`mês de contrato sem cobrança única: ${key}`);
        }
      }
    }

    for (const user of portalUsers) {
      const renterLinks = user.person?.renters ?? [];
      const activeLink = renterLinks.find(({ lease }) =>
        lease.startDate <= CRMWARE_DEMO_ANCHOR && (!lease.endDate || lease.endDate >= CRMWARE_DEMO_ANCHOR),
      );
      if (!activeLink || activeLink.lease.charges.length === 0) errors.push(`portal sem contrato ativo e movimentos: ${user.email}`);
    }

    const invalidRelations = relationRows.filter((unit) =>
      unit.tenantId !== tenantId ||
      unit.building.tenantId !== tenantId ||
      unit.building.property.tenantId !== tenantId ||
      unit.leases.some((lease) => lease.tenantId !== tenantId) ||
      unit.owners.some((owner) => owner.tenantId !== tenantId || owner.person.tenantId !== tenantId),
    ).length;
    if (invalidRelations) errors.push(`${invalidRelations} relações cruzam tenants`);

    for (const ticket of ticketRows) {
      if (!ticket.unit || ticket.propertyId !== ticket.unit.building.propertyId) errors.push("ocorrência ligada a imóvel diferente da fração");
      if (ticket.reporter?.personId && !ticket.unit?.leases.some((lease) =>
        lease.renters.some((renter) => renter.personId === ticket.reporter!.personId)
        && lease.startDate <= ticket.createdAt
        && (!lease.endDate || lease.endDate >= ticket.createdAt),
      )) {
        errors.push("autor da ocorrência não tinha contrato vigente na data");
      }
    }
    if (scenario.targets.activeLeases && !ticketRows.some((ticket) => ticket.reporter)) errors.push("nenhuma ocorrência reportada por inquilino");

    if (condoOwnerRows.some((person) => person.owners.length === 0)) errors.push("condómino sem fração");
    if (condoAccounts.some((account) => account.payments.length === 0)) errors.push("condomínio sem movimentos financeiros");
    if (rentAccounts.some((account) => account.payments.some((payment) => !payment.chargeId))) errors.push("movimento da conta de rendas sem cobrança");

    for (const meeting of meetingRows) {
      if (meeting.status === "DURCHGEFUEHRT" && (meeting.date > CRMWARE_DEMO_ANCHOR || !meeting.protocol)) errors.push("assembleia realizada com data/ata incoerente");
      if (meeting.status === "GEPLANT" && (meeting.date <= CRMWARE_DEMO_ANCHOR || meeting.protocol || meeting.resolutions.length)) errors.push("assembleia planeada com data/resultado incoerente");
      if (meeting.resolutions.some((resolution) => resolution.propertyId !== meeting.propertyId)) errors.push("deliberação ligada a outro imóvel");
      const eligibleVotes = meeting.property.buildings.reduce((total, building) => total + building.units.length, 0);
      if (meeting.resolutions.some((resolution) => resolution.votesYes + resolution.votesNo + resolution.votesAbstain > eligibleVotes)) {
        errors.push("deliberação com mais votos do que frações");
      }
      if (meeting.resolutions.some((resolution) => resolution.result === "VERTAGT"
        ? resolution.votesYes + resolution.votesNo + resolution.votesAbstain !== 0
        : resolution.result === "ANGENOMMEN"
          ? resolution.votesYes <= resolution.votesNo
          : resolution.votesYes > resolution.votesNo)) {
        errors.push("resultado da deliberação incoerente com os votos");
      }
    }
    const resolutionKeys = meetingRows.flatMap((meeting) => meeting.resolutions.map((resolution) => `${resolution.propertyId}:${resolution.number}`));
    if (new Set(resolutionKeys).size !== resolutionKeys.length) errors.push("números de deliberação duplicados no mesmo imóvel");

    const customRows = [...personRows, ...propertyRows];
    for (const row of customRows) {
      const custom = typeof row.custom === "object" && row.custom !== null && !Array.isArray(row.custom) ? row.custom as Record<string, unknown> : {};
      if (typeof custom.nif === "string" && isValidPtNif(custom.nif)) errors.push(`NIF sintético válido: ${custom.nif}`);
    }

    for (const document of documentRows) {
      if (!document.unit || document.propertyId !== document.unit.building.propertyId) errors.push(`documento ligado a imóvel diferente da fração: ${document.storageKey}`);
      if (document.personId) {
        const related = document.person?.owners.some((owner) => owner.unitId === document.unitId)
          || document.person?.renters.some((renter) => renter.lease.unitId === document.unitId);
        if (!related) errors.push(`pessoa do documento não está ligada à fração: ${document.storageKey}`);
      }
      if (document.payments.some((payment) => Number(document.invoiceTotal) !== Number(payment.amount) || document.createdAt.getTime() !== payment.date.getTime())) {
        errors.push(`fatura incompatível com pagamento: ${document.storageKey}`);
      }
      try {
        const stat = await fs.stat(path.join(STORAGE, path.basename(document.storageKey)));
        if (document.size <= 0 || stat.size !== document.size) errors.push(`documento inválido: ${document.storageKey}`);
      } catch {
        errors.push(`ficheiro em falta: ${document.storageKey}`);
      }
    }
    rows.push({ scenario: scenario.key, errors, counts });
  }
  return rows;
}

async function main(): Promise<void> {
  const definitionErrors = validateScenarioDefinitions(CRMWARE_DEMO_SCENARIOS);
  if (definitionErrors.length) throw new Error(definitionErrors.join("\n"));
  if (!process.argv.includes("--validate")) {
    const password = assertDemoSeedAllowed(process.env);
    for (const scenario of CRMWARE_DEMO_SCENARIOS) await assertScenarioTenantOwnership(scenario);
    const passwordHash = await bcrypt.hash(password, 10);
    for (const scenario of CRMWARE_DEMO_SCENARIOS) {
      console.log(`A preparar ${scenario.tenantName}...`);
      await seedScenario(scenario, passwordHash);
    }
  }
  const validation = await validateSeededScenarios();
  for (const row of validation) console.log(`${row.scenario}: ${row.errors.length ? `ERRO - ${row.errors.join("; ")}` : "OK"}`, row.counts);
  if (validation.some((row) => row.errors.length)) process.exitCode = 1;
  else console.log("Seed CrmWare validado. Use a password definida em CRMWARE_DEMO_PASSWORD.");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
