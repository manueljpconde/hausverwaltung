-- #52 Release 2 (Domínio). Voraussetzung: noch keine Emissionen (Fundação hat keinen Generator).
LOCK TABLE "CondominiumAssessment" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CondominiumAssessment") THEN
    RAISE EXCEPTION '#52 R2: CondominiumAssessment enthält Daten; diese Migration setzt keine Emissionen voraus.';
  END IF;
END $$;

-- Stornierung: Zeitpunkt und Grund genau bei CANCELLED.
ALTER TABLE "Charge" ADD COLUMN "cancelledAt" TIMESTAMP(3), ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "Charge" ADD CONSTRAINT charge_cancel_consistency CHECK (
  ("status" = 'ISSUED' AND "cancelledAt" IS NULL AND "cancelReason" IS NULL)
  OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL AND btrim("cancelReason") <> '')
);

-- Assessment: Beschreibung, Deliberação, Anfrage-Identität.
ALTER TABLE "CondominiumAssessment" ADD COLUMN "description" TEXT, ADD COLUMN "resolutionId" TEXT, ADD COLUMN "requestKey" TEXT NOT NULL;
CREATE UNIQUE INDEX "Resolution_id_tenantId_key" ON "Resolution"("id", "tenantId");
ALTER TABLE "CondominiumAssessment" ADD CONSTRAINT "CondominiumAssessment_resolutionId_tenantId_fkey"
  FOREIGN KEY ("resolutionId", "tenantId") REFERENCES "Resolution"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deliberação und Assessment im selben Objekt, in beide Richtungen, mit FOR SHARE gegen Nebenläufigkeit.
CREATE FUNCTION assessment_resolution_same_property() RETURNS trigger AS $$
DECLARE res_property TEXT;
BEGIN
  IF NEW."resolutionId" IS NULL THEN RETURN NEW; END IF;
  SELECT r."propertyId" INTO res_property FROM "Resolution" r
    WHERE r.id = NEW."resolutionId" AND r."tenantId" = NEW."tenantId" FOR SHARE;
  -- fehlende/fremde Deliberação meldet die zusammengesetzte FK
  IF res_property IS NOT NULL AND res_property <> NEW."propertyId" THEN
    RAISE EXCEPTION 'assessment resolution not in assessment property';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER assessment_resolution_same_property BEFORE INSERT OR UPDATE OF "resolutionId", "propertyId" ON "CondominiumAssessment"
  FOR EACH ROW EXECUTE FUNCTION assessment_resolution_same_property();

CREATE FUNCTION resolution_move_keeps_assessments() RETURNS trigger AS $$
BEGIN
  IF NEW."propertyId" IS DISTINCT FROM OLD."propertyId" AND EXISTS (
    SELECT 1 FROM "CondominiumAssessment" a
    WHERE a."resolutionId" = NEW.id AND a."tenantId" = NEW."tenantId" AND a."propertyId" <> NEW."propertyId"
  ) THEN
    RAISE EXCEPTION 'assessment resolution not in assessment property';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER resolution_move_keeps_assessments BEFORE UPDATE OF "propertyId" ON "Resolution"
  FOR EACH ROW EXECUTE FUNCTION resolution_move_keeps_assessments();

-- Wirtschaftsplan gesperrt, solange ordentliche ISSUED-Emissionen des Jahres existieren.
-- Gemeinsamer Serialisierungspunkt mit der Emission: Advisory-Lock je (tenant, Objekt, Jahr);
-- Kollisionen des Hashes serialisieren nur zu viel, nie zu wenig.
CREATE FUNCTION plan_lock_key(tenant TEXT, property TEXT, yr INT) RETURNS BIGINT AS $$
  SELECT hashtextextended(tenant || ':' || property || ':' || yr::text, 0)
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION economic_plan_locked_by_issued_ordinary() RETURNS trigger AS $$
DECLARE k_old BIGINT; k_new BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."totalAmount" = OLD."totalAmount" AND NEW."year" = OLD."year" AND NEW."propertyId" = OLD."propertyId" THEN
    RETURN NEW; -- z. B. nur Notiz geändert
  END IF;
  k_old := plan_lock_key(OLD."tenantId", OLD."propertyId", OLD."year");
  IF TG_OP = 'UPDATE' THEN
    k_new := plan_lock_key(NEW."tenantId", NEW."propertyId", NEW."year");
    -- feste Reihenfolge (bigint aufsteigend) gegen Deadlocks bei gegenläufigen Änderungen
    PERFORM pg_advisory_xact_lock(LEAST(k_old, k_new));
    IF k_new <> k_old THEN PERFORM pg_advisory_xact_lock(GREATEST(k_old, k_new)); END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(k_old);
  END IF;
  -- erst unter der Sperre prüfen
  IF EXISTS (
    SELECT 1 FROM "CondominiumAssessment" a
    WHERE a."tenantId" = OLD."tenantId" AND a.kind = 'ORDINARY' AND a.status = 'ISSUED'
      AND ((a."propertyId" = OLD."propertyId" AND EXTRACT(YEAR FROM a.period) = OLD."year")
        OR (TG_OP = 'UPDATE' AND a."propertyId" = NEW."propertyId" AND EXTRACT(YEAR FROM a.period) = NEW."year"))
  ) THEN
    RAISE EXCEPTION 'plan locked by issued ordinary assessments';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER economic_plan_locked_by_issued_ordinary BEFORE UPDATE OR DELETE ON "EconomicPlan"
  FOR EACH ROW EXECUTE FUNCTION economic_plan_locked_by_issued_ordinary();
