-- #52 Fundação: endgültiges Finanzschema. Keine Altdaten → kein Backfill; Abbruch, falls doch welche existieren.
-- Das Skript läuft als eine implizite Transaktion: die Sperre hält bis zum Ende, kein Schreiber kann zwischen Prüfung und DROP einfügen.
LOCK TABLE "Charge", "Payment" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Charge") OR EXISTS (SELECT 1 FROM "Payment") THEN
    RAISE EXCEPTION '#52: Charge/Payment enthalten Daten; diese Migration setzt eine leere Finanzbasis voraus.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "ChargeStatus" AS ENUM ('ISSUED', 'CANCELLED');
CREATE TYPE "OwnerVigencia" AS ENUM ('CONFIRMED', 'UNKNOWN');
CREATE TYPE "QuotaKind" AS ENUM ('ORDINARY', 'EXTRAORDINARY');
CREATE TYPE "AssessmentMethod" AS ENUM ('PERMILLAGE', 'FIXED', 'CUSTOM');
CREATE TYPE "AssessmentStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- Tenant: Stichtag, für Bestehende = Zeitpunkt dieser Transaktion, für Neue = Anlage.
ALTER TABLE "Tenant" ADD COLUMN "ownerValidityCutoverAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "Tenant" SET "ownerValidityCutoverAt" = transaction_timestamp();
CREATE FUNCTION tenant_cutover_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."ownerValidityCutoverAt" IS NOT NULL
     AND NEW."ownerValidityCutoverAt" IS DISTINCT FROM OLD."ownerValidityCutoverAt" THEN
    RAISE EXCEPTION 'ownerValidityCutoverAt is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tenant_cutover_immutable BEFORE UPDATE OF "ownerValidityCutoverAt" ON "Tenant"
  FOR EACH ROW EXECUTE FUNCTION tenant_cutover_immutable();

-- Owner: Gültigkeit; Bestehende = UNKNOWN, Neue = CONFIRMED (Default) → ohne validFrom scheitert der CHECK.
ALTER TABLE "Owner" ADD COLUMN "validFrom" TIMESTAMP(3), ADD COLUMN "validTo" TIMESTAMP(3),
  ADD COLUMN "vigencia" "OwnerVigencia" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "Owner" ALTER COLUMN "vigencia" SET DEFAULT 'CONFIRMED';
ALTER TABLE "Owner" ADD CONSTRAINT owner_confirmed_needs_valid_from CHECK ("vigencia" <> 'CONFIRMED' OR "validFrom" IS NOT NULL);
ALTER TABLE "Owner" ADD CONSTRAINT owner_valid_range CHECK ("validTo" IS NULL OR "validFrom" IS NULL OR "validTo" > "validFrom");
ALTER TABLE "Owner" ADD CONSTRAINT owner_no_overlap EXCLUDE USING gist (
  "unitId" WITH =, "personId" WITH =,
  tsrange(COALESCE("validFrom", '-infinity'::timestamp), COALESCE("validTo", 'infinity'::timestamp), '[)') WITH &&
);

-- Ziele zusammengesetzter FKs (id, tenantId): Mandantengrenzen liegen in der DB.
CREATE UNIQUE INDEX "Lease_id_tenantId_key" ON "Lease"("id", "tenantId");
CREATE UNIQUE INDEX "AreaAllocation_id_tenantId_key" ON "AreaAllocation"("id", "tenantId");
CREATE UNIQUE INDEX "Property_id_tenantId_key" ON "Property"("id", "tenantId");
CREATE UNIQUE INDEX "Unit_id_tenantId_key" ON "Unit"("id", "tenantId");
CREATE UNIQUE INDEX "Person_id_tenantId_key" ON "Person"("id", "tenantId");

-- Quota-Tabellen.
CREATE TABLE "CondominiumAssessment" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "propertyId" TEXT NOT NULL,
  "period" TIMESTAMP(3) NOT NULL, "kind" "QuotaKind" NOT NULL, "method" "AssessmentMethod" NOT NULL,
  "dueDate" TIMESTAMP(3) NOT NULL, "asOf" TIMESTAMP(3) NOT NULL, "totalCents" INTEGER NOT NULL,
  "status" "AssessmentStatus" NOT NULL DEFAULT 'ISSUED', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT assessment_total_nonneg CHECK ("totalCents" >= 0)
);
CREATE UNIQUE INDEX "CondominiumAssessment_id_tenantId_key" ON "CondominiumAssessment"("id", "tenantId");
CREATE INDEX "CondominiumAssessment_tenantId_idx" ON "CondominiumAssessment"("tenantId");
CREATE UNIQUE INDEX assessment_issued_uniq ON "CondominiumAssessment"("tenantId", "propertyId", "period", "kind") WHERE "status" = 'ISSUED';
ALTER TABLE "CondominiumAssessment" ADD CONSTRAINT "CondominiumAssessment_propertyId_tenantId_fkey"
  FOREIGN KEY ("propertyId", "tenantId") REFERENCES "Property"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CondominiumAssessmentLine" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "assessmentId" TEXT NOT NULL, "unitId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL, CONSTRAINT line_amount_nonneg CHECK ("amountCents" >= 0)
);
CREATE UNIQUE INDEX "CondominiumAssessmentLine_assessmentId_unitId_key" ON "CondominiumAssessmentLine"("assessmentId", "unitId");
CREATE UNIQUE INDEX "CondominiumAssessmentLine_id_tenantId_key" ON "CondominiumAssessmentLine"("id", "tenantId");
CREATE INDEX "CondominiumAssessmentLine_tenantId_idx" ON "CondominiumAssessmentLine"("tenantId");
ALTER TABLE "CondominiumAssessmentLine" ADD CONSTRAINT "CondominiumAssessmentLine_assessmentId_tenantId_fkey"
  FOREIGN KEY ("assessmentId", "tenantId") REFERENCES "CondominiumAssessment"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CondominiumAssessmentLine" ADD CONSTRAINT "CondominiumAssessmentLine_unitId_tenantId_fkey"
  FOREIGN KEY ("unitId", "tenantId") REFERENCES "Unit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "QuotaDebtorSnapshot" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "lineId" TEXT NOT NULL, "personId" TEXT NOT NULL,
  "shareSnapshot" INTEGER NOT NULL, "amountCents" INTEGER NOT NULL,
  CONSTRAINT snapshot_share_range CHECK ("shareSnapshot" BETWEEN 1 AND 1000),
  CONSTRAINT snapshot_amount_nonneg CHECK ("amountCents" >= 0)
);
CREATE UNIQUE INDEX "QuotaDebtorSnapshot_lineId_personId_key" ON "QuotaDebtorSnapshot"("lineId", "personId");
CREATE UNIQUE INDEX "QuotaDebtorSnapshot_id_tenantId_key" ON "QuotaDebtorSnapshot"("id", "tenantId");
CREATE INDEX "QuotaDebtorSnapshot_tenantId_idx" ON "QuotaDebtorSnapshot"("tenantId");
ALTER TABLE "QuotaDebtorSnapshot" ADD CONSTRAINT "QuotaDebtorSnapshot_lineId_tenantId_fkey"
  FOREIGN KEY ("lineId", "tenantId") REFERENCES "CondominiumAssessmentLine"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuotaDebtorSnapshot" ADD CONSTRAINT "QuotaDebtorSnapshot_personId_tenantId_fkey"
  FOREIGN KEY ("personId", "tenantId") REFERENCES "Person"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Charge: Status, Quota-Ziel, Restrict, genau ein Ziel, Eindeutigkeit nur für ISSUED.
ALTER TABLE "Charge" ADD COLUMN "status" "ChargeStatus" NOT NULL DEFAULT 'ISSUED', ADD COLUMN "quotaDebtorSnapshotId" TEXT;
ALTER TABLE "Charge" DROP CONSTRAINT "Charge_leaseId_fkey";
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_leaseId_tenantId_fkey" FOREIGN KEY ("leaseId", "tenantId") REFERENCES "Lease"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Charge" DROP CONSTRAINT "Charge_areaAllocationId_fkey";
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_areaAllocationId_tenantId_fkey" FOREIGN KEY ("areaAllocationId", "tenantId") REFERENCES "AreaAllocation"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_quotaDebtorSnapshotId_tenantId_fkey"
  FOREIGN KEY ("quotaDebtorSnapshotId", "tenantId") REFERENCES "QuotaDebtorSnapshot"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Charge" ADD CONSTRAINT charge_exactly_one_target CHECK (
  (("leaseId" IS NOT NULL)::int + ("areaAllocationId" IS NOT NULL)::int + ("quotaDebtorSnapshotId" IS NOT NULL)::int) = 1
);
ALTER TABLE "Charge" ADD CONSTRAINT charge_hausgeld_needs_snapshot CHECK (("type" = 'HAUSGELD') = ("quotaDebtorSnapshotId" IS NOT NULL));
ALTER TABLE "Charge" ADD CONSTRAINT charge_amount_positive CHECK ("amount" > 0);
DROP INDEX "Charge_areaAllocationId_period_key";
CREATE UNIQUE INDEX "Charge_id_tenantId_key" ON "Charge"("id", "tenantId");
CREATE INDEX "Charge_areaAllocationId_idx" ON "Charge"("areaAllocationId");
CREATE INDEX "Charge_quotaDebtorSnapshotId_idx" ON "Charge"("quotaDebtorSnapshotId");
CREATE UNIQUE INDEX charge_area_issued_uniq ON "Charge"("areaAllocationId", "period") WHERE "status" = 'ISSUED' AND "areaAllocationId" IS NOT NULL;
CREATE UNIQUE INDEX charge_rent_issued_uniq ON "Charge"("leaseId", "period") WHERE "status" = 'ISSUED' AND "type" = 'MIETE' AND "leaseId" IS NOT NULL;
CREATE UNIQUE INDEX charge_quota_issued_uniq ON "Charge"("quotaDebtorSnapshotId") WHERE "status" = 'ISSUED' AND "quotaDebtorSnapshotId" IS NOT NULL;

-- Payment: chargeId entfällt; (id, tenantId) für die Zuordnung.
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_chargeId_fkey";
DROP INDEX "Payment_chargeId_idx";
ALTER TABLE "Payment" DROP COLUMN "chargeId";
CREATE UNIQUE INDEX "Payment_id_tenantId_key" ON "Payment"("id", "tenantId");

CREATE TABLE "PaymentAllocation" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "paymentId" TEXT NOT NULL, "chargeId" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT allocation_amount_positive CHECK ("amount" > 0)
);
CREATE INDEX "PaymentAllocation_tenantId_idx" ON "PaymentAllocation"("tenantId");
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");
CREATE INDEX "PaymentAllocation_chargeId_idx" ON "PaymentAllocation"("chargeId");
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_tenantId_fkey"
  FOREIGN KEY ("paymentId", "tenantId") REFERENCES "Payment"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_chargeId_tenantId_fkey"
  FOREIGN KEY ("chargeId", "tenantId") REFERENCES "Charge"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Konten, Eigentümer, Mahnungen: zusammengesetzte FKs (x, tenantId) → (id, tenantId).
-- SET NULL nur auf accountId (PostgreSQL 15+): tenantId ist NOT NULL und bleibt erhalten.
CREATE UNIQUE INDEX "Account_id_tenantId_key" ON "Account"("id", "tenantId");
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_accountId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_accountId_tenantId_fkey"
  FOREIGN KEY ("accountId", "tenantId") REFERENCES "Account"("id", "tenantId") ON DELETE SET NULL ("accountId") ON UPDATE CASCADE;
ALTER TABLE "Deposit" DROP CONSTRAINT "Deposit_accountId_fkey";
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_accountId_tenantId_fkey"
  FOREIGN KEY ("accountId", "tenantId") REFERENCES "Account"("id", "tenantId") ON DELETE SET NULL ("accountId") ON UPDATE CASCADE;
ALTER TABLE "BankLink" DROP CONSTRAINT "BankLink_accountId_fkey";
ALTER TABLE "BankLink" ADD CONSTRAINT "BankLink_accountId_tenantId_fkey"
  FOREIGN KEY ("accountId", "tenantId") REFERENCES "Account"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Owner" DROP CONSTRAINT "Owner_personId_fkey";
ALTER TABLE "Owner" ADD CONSTRAINT "Owner_personId_tenantId_fkey"
  FOREIGN KEY ("personId", "tenantId") REFERENCES "Person"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Owner" DROP CONSTRAINT "Owner_unitId_fkey";
ALTER TABLE "Owner" ADD CONSTRAINT "Owner_unitId_tenantId_fkey"
  FOREIGN KEY ("unitId", "tenantId") REFERENCES "Unit"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict statt Cascade: eine Sollstellung mit Mahnung verschwindet nicht still.
ALTER TABLE "DunningNotice" DROP CONSTRAINT "DunningNotice_chargeId_fkey";
ALTER TABLE "DunningNotice" ADD CONSTRAINT "DunningNotice_chargeId_tenantId_fkey"
  FOREIGN KEY ("chargeId", "tenantId") REFERENCES "Charge"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quota-Zeile: die Einheit muss im Objekt des Assessments liegen (Unit → Building → Property).
-- Fehlt Einheit oder Assessment im Mandanten, greift die zusammengesetzte FK mit ihrem eigenen Namen.
CREATE FUNCTION assessment_line_unit_in_property() RETURNS trigger AS $$
DECLARE unit_property TEXT; assessment_property TEXT;
BEGIN
  SELECT b."propertyId" INTO unit_property FROM "Unit" u JOIN "Building" b ON b.id = u."buildingId"
    WHERE u.id = NEW."unitId" AND u."tenantId" = NEW."tenantId";
  SELECT a."propertyId" INTO assessment_property FROM "CondominiumAssessment" a
    WHERE a.id = NEW."assessmentId" AND a."tenantId" = NEW."tenantId";
  IF unit_property IS DISTINCT FROM assessment_property AND unit_property IS NOT NULL AND assessment_property IS NOT NULL THEN
    RAISE EXCEPTION 'assessment line unit not in assessment property';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER assessment_line_unit_in_property BEFORE INSERT OR UPDATE ON "CondominiumAssessmentLine"
  FOR EACH ROW EXECUTE FUNCTION assessment_line_unit_in_property();
