-- CreateEnum
CREATE TYPE "TenantMarket" AS ENUM ('DE', 'PT');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "market" "TenantMarket" NOT NULL DEFAULT 'DE';
