// Nur für Tests: WEG-Objekt mit Einheiten, Eigentümern und Wirtschaftsplan.
import type { PrismaClient } from "@prisma/client";

export async function wegFixture(db: PrismaClient, tenantId: string, opts: { meas?: number[]; annual?: number; year?: number } = {}) {
  const meas = opts.meas ?? [400, 600];
  const year = opts.year ?? 2026;
  const property = await db.property.create({ data: { tenantId, name: "Cond", street: "S", zip: "1000-001", city: "Lisboa", management: "WEG", meaTotal: meas.reduce((a, b) => a + b, 0) } });
  const building = await db.building.create({ data: { tenantId, propertyId: property.id, name: "B" } });
  const units = [];
  const persons = [];
  for (let i = 0; i < meas.length; i++) {
    const unit = await db.unit.create({ data: { tenantId, buildingId: building.id, label: `F${i + 1}`, area: 50, mea: meas[i] } });
    const person = await db.person.create({ data: { tenantId, firstName: `P${i + 1}`, lastName: "Teste" } });
    await db.owner.create({ data: { tenantId, unitId: unit.id, personId: person.id, share: 1000, vigencia: "CONFIRMED", validFrom: new Date(Date.UTC(2020, 0, 1)) } });
    units.push(unit);
    persons.push(person);
  }
  const plan = await db.economicPlan.create({ data: { tenantId, propertyId: property.id, year, totalAmount: opts.annual ?? 1200 } });
  return { property, building, units, persons, plan };
}
