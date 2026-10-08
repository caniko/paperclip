-- Parent barrier precedes the enrollment FK replacement. The migrator applies
-- this entire file transactionally, so inserts never observe a guardless gap.
LOCK TABLE "companies", "mcp_worker_enrollments" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "mcp_company_retired_enrollments" (
	"company_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"revision" uuid NOT NULL,
	CONSTRAINT "mcp_company_retired_enrollments_company_id_enrollment_id_pk" PRIMARY KEY("company_id","enrollment_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_company_retired_launches" (
	"company_id" uuid NOT NULL,
	"launch_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid,
	"project_id" uuid,
	"controller_boot_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	CONSTRAINT "mcp_company_retired_launches_company_id_launch_id_pk" PRIMARY KEY("company_id","launch_id"),
	CONSTRAINT "mcp_company_retired_launches_generation_ck" CHECK ("mcp_company_retired_launches"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "mcp_company_retirements" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"controller_instance_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"retired_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"enrollment_count" integer NOT NULL,
	"launch_count" integer NOT NULL,
	CONSTRAINT "mcp_company_retirements_identity_ck" CHECK (length(trim("mcp_company_retirements"."actor_id")) between 1 and 256 and length("mcp_company_retirements"."controller_instance_id") between 1 and 128),
	CONSTRAINT "mcp_company_retirements_counts_ck" CHECK ("mcp_company_retirements"."enrollment_count" between 0 and 1024 and "mcp_company_retirements"."launch_count" between 0 and 1024 and "mcp_company_retirements"."enrollment_count" + "mcp_company_retirements"."launch_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "mcp_worker_enrollments" DROP CONSTRAINT "mcp_worker_enrollments_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_company_retired_enrollments" ADD CONSTRAINT "mcp_company_retired_enrollments_company_id_mcp_company_retirements_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."mcp_company_retirements"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_company_retired_launches" ADD CONSTRAINT "mcp_company_retired_launches_company_id_mcp_company_retirements_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."mcp_company_retirements"("company_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION block_mcp_retirement_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MCP retirement receipts and key tombstones must be retained';
END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_mcp_company_retirements BEFORE UPDATE OR DELETE OR TRUNCATE ON mcp_company_retirements
  FOR EACH STATEMENT EXECUTE FUNCTION block_mcp_retirement_receipt_mutation();
--> statement-breakpoint
CREATE TRIGGER immutable_mcp_company_retired_enrollments BEFORE UPDATE OR DELETE OR TRUNCATE ON mcp_company_retired_enrollments
  FOR EACH STATEMENT EXECUTE FUNCTION block_mcp_retirement_receipt_mutation();
--> statement-breakpoint
CREATE TRIGGER immutable_mcp_company_retired_launches BEFORE UPDATE OR DELETE OR TRUNCATE ON mcp_company_retired_launches
  FOR EACH STATEMENT EXECUTE FUNCTION block_mcp_retirement_receipt_mutation();
--> statement-breakpoint
CREATE TRIGGER immutable_mcp_worker_enrollment_truncate BEFORE TRUNCATE ON mcp_worker_enrollments
  FOR EACH STATEMENT EXECUTE FUNCTION block_mcp_retirement_receipt_mutation();
--> statement-breakpoint
CREATE TRIGGER immutable_mcp_prepared_launch_truncate BEFORE TRUNCATE ON mcp_prepared_launches
  FOR EACH STATEMENT EXECUTE FUNCTION block_mcp_retirement_receipt_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_mcp_prepared_launch_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM companies WHERE id = NEW.company_id FOR KEY SHARE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM mcp_company_retirements WHERE company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'MCP launch company is missing or retiring';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.company_id, NEW.agent_id, NEW.run_id, NEW.issue_id, NEW.project_id,
        NEW.controller_boot_id, NEW.generation, NEW.launch_digest, NEW.expires_at, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.company_id, OLD.agent_id, OLD.run_id, OLD.issue_id, OLD.project_id,
        OLD.controller_boot_id, OLD.generation, OLD.launch_digest, OLD.expires_at, OLD.created_at) THEN
      RAISE EXCEPTION 'MCP launch identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  -- Receipt insertion alone cannot prove the identity of a later deleted row.
  -- Validate OLD at deletion and disallow post-header insertion/substitution.
  IF EXISTS (SELECT 1 FROM mcp_company_retirements WHERE company_id = OLD.company_id)
    AND NOT EXISTS (SELECT 1 FROM mcp_company_retired_launches
      WHERE company_id = OLD.company_id AND launch_id = OLD.id AND agent_id = OLD.agent_id AND run_id = OLD.run_id
        AND issue_id IS NOT DISTINCT FROM OLD.issue_id AND project_id IS NOT DISTINCT FROM OLD.project_id
        AND controller_boot_id = OLD.controller_boot_id AND generation = OLD.generation) THEN
    RAISE EXCEPTION 'MCP launch deletion requires its exact retirement receipt';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_mcp_prepared_launch_retirement BEFORE INSERT OR UPDATE OR DELETE ON mcp_prepared_launches
  FOR EACH ROW EXECUTE FUNCTION guard_mcp_prepared_launch_retirement();
--> statement-breakpoint
CREATE FUNCTION guard_mcp_company_retirement_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE company_status text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'MCP company retirement requires READ COMMITTED isolation';
  END IF;
  SELECT status INTO company_status FROM companies WHERE id = NEW.company_id FOR KEY SHARE;
  IF NOT FOUND OR company_status <> 'archived' THEN
    RAISE EXCEPTION 'MCP company retirement requires an archived company';
  END IF;
  IF NEW.retired_at > clock_timestamp() OR EXISTS (
      SELECT 1 FROM mcp_worker_enrollments WHERE company_id = NEW.company_id AND state <> 'revoked')
    OR NEW.enrollment_count <> (SELECT count(*) FROM mcp_worker_enrollments WHERE company_id = NEW.company_id)
    OR NEW.launch_count <> (SELECT count(*) FROM mcp_prepared_launches WHERE company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'MCP company retirement transition scope does not match';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_mcp_company_retirement_insert BEFORE INSERT ON mcp_company_retirements
  FOR EACH ROW EXECUTE FUNCTION guard_mcp_company_retirement_insert();
--> statement-breakpoint
CREATE FUNCTION guard_mcp_company_retirement_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM companies WHERE id = NEW.company_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MCP company retirement receipt is sealed'; END IF;
  IF TG_TABLE_NAME = 'mcp_company_retired_enrollments' THEN
    IF NOT EXISTS (SELECT 1 FROM mcp_worker_enrollments
      WHERE id = NEW.enrollment_id AND company_id = NEW.company_id AND state = 'revoked' AND revision = NEW.revision) THEN
      RAISE EXCEPTION 'MCP enrollment retirement receipt does not match';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM mcp_prepared_launches
      WHERE id = NEW.launch_id AND company_id = NEW.company_id AND agent_id = NEW.agent_id AND run_id = NEW.run_id
        AND issue_id IS NOT DISTINCT FROM NEW.issue_id AND project_id IS NOT DISTINCT FROM NEW.project_id
        AND controller_boot_id = NEW.controller_boot_id AND generation = NEW.generation) THEN
      RAISE EXCEPTION 'MCP launch retirement receipt does not match';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_mcp_company_retired_enrollment_insert BEFORE INSERT ON mcp_company_retired_enrollments
  FOR EACH ROW EXECUTE FUNCTION guard_mcp_company_retirement_entry();
--> statement-breakpoint
CREATE TRIGGER guard_mcp_company_retired_launch_insert BEFORE INSERT ON mcp_company_retired_launches
  FOR EACH ROW EXECUTE FUNCTION guard_mcp_company_retirement_entry();
--> statement-breakpoint
CREATE FUNCTION require_complete_mcp_company_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM companies WHERE id = NEW.company_id)
    OR EXISTS (SELECT 1 FROM mcp_prepared_launches WHERE company_id = NEW.company_id)
    OR NEW.enrollment_count <> (SELECT count(*) FROM mcp_company_retired_enrollments WHERE company_id = NEW.company_id)
    OR NEW.launch_count <> (SELECT count(*) FROM mcp_company_retired_launches WHERE company_id = NEW.company_id)
    OR NEW.enrollment_count <> (SELECT count(*) FROM mcp_worker_enrollments WHERE company_id = NEW.company_id)
    OR EXISTS (SELECT 1 FROM mcp_worker_enrollments e WHERE e.company_id = NEW.company_id AND
      (e.state <> 'revoked' OR NOT EXISTS (SELECT 1 FROM mcp_company_retired_enrollments receipt
        WHERE receipt.company_id = e.company_id AND receipt.enrollment_id = e.id AND receipt.revision = e.revision))) THEN
    RAISE EXCEPTION 'MCP company retirement must commit with complete deletion receipts';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER require_complete_mcp_company_retirement AFTER INSERT ON mcp_company_retirements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_mcp_company_retirement();
--> statement-breakpoint
CREATE FUNCTION guard_mcp_company_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Company UUIDs are immutable';
  END IF;
  -- The volatile-function snapshot is fresh after unique-key contention only at
  -- READ COMMITTED. A repeatable-read contender must not reuse its old snapshot.
  IF TG_OP = 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Company UUID insertion requires READ COMMITTED isolation';
  END IF;
  IF EXISTS (SELECT 1 FROM mcp_company_retirements WHERE company_id = NEW.id) THEN
    RAISE EXCEPTION 'Retired MCP company UUID cannot be reused';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_mcp_company_rekey BEFORE UPDATE OF id ON companies
  FOR EACH ROW EXECUTE FUNCTION guard_mcp_company_identity();
--> statement-breakpoint
CREATE TRIGGER guard_mcp_company_uuid_reuse AFTER INSERT ON companies
  FOR EACH ROW EXECUTE FUNCTION guard_mcp_company_identity();
--> statement-breakpoint
CREATE FUNCTION guard_mcp_company_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retirement mcp_company_retirements%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Company deletion requires READ COMMITTED isolation';
  END IF;
  IF EXISTS (SELECT 1 FROM mcp_prepared_launches WHERE company_id = OLD.id) THEN
    RAISE EXCEPTION 'MCP launch recovery must settle before company deletion';
  END IF;
  IF EXISTS (SELECT 1 FROM mcp_worker_enrollments WHERE company_id = OLD.id) THEN
    SELECT * INTO retirement FROM mcp_company_retirements WHERE company_id = OLD.id;
    IF NOT FOUND OR retirement.enrollment_count <> (SELECT count(*) FROM mcp_worker_enrollments WHERE company_id = OLD.id)
      OR retirement.enrollment_count <> (SELECT count(*) FROM mcp_company_retired_enrollments WHERE company_id = OLD.id)
      OR EXISTS (SELECT 1 FROM mcp_worker_enrollments e WHERE e.company_id = OLD.id AND
        (e.state <> 'revoked' OR NOT EXISTS (SELECT 1 FROM mcp_company_retired_enrollments receipt
          WHERE receipt.company_id = e.company_id AND receipt.enrollment_id = e.id AND receipt.revision = e.revision))) THEN
      RAISE EXCEPTION 'MCP company deletion requires exact permanent enrollment receipts';
    END IF;
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_mcp_company_delete BEFORE DELETE ON companies
  FOR EACH ROW EXECUTE FUNCTION guard_mcp_company_delete();
--> statement-breakpoint
CREATE FUNCTION guard_mcp_company_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mcp_worker_enrollments) OR EXISTS (SELECT 1 FROM mcp_prepared_launches) THEN
    RAISE EXCEPTION 'MCP company deletion requires scoped retirement';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_mcp_company_truncate BEFORE TRUNCATE ON companies
  FOR EACH STATEMENT EXECUTE FUNCTION guard_mcp_company_truncate();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_mcp_worker_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MCP worker enrollment tombstone must be retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM companies WHERE id = NEW.company_id FOR KEY SHARE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM mcp_company_retirements WHERE company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'MCP worker enrollment company is missing or retired';
    END IF;
    IF NEW.state <> 'pending' OR NEW.enrolled_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'MCP worker enrollment must start pending';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.company_id, NEW.controller_instance_id, NEW.worker_id, NEW.key_id,
      NEW.public_key, NEW.gateway_url, NEW.execution_host_id, NEW.bootstrap_token_hash,
      NEW.nonce, NEW.challenge_expires_at, NEW.expires_at, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.company_id, OLD.controller_instance_id, OLD.worker_id, OLD.key_id,
      OLD.public_key, OLD.gateway_url, OLD.execution_host_id, OLD.bootstrap_token_hash,
      OLD.nonce, OLD.challenge_expires_at, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'MCP worker enrollment pins are immutable';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW.revision = OLD.revision THEN
    RAISE EXCEPTION 'MCP worker enrollment transition requires a fresh revision';
  END IF;
  IF OLD.state = 'pending' AND NEW.state = 'enrolled' AND NEW.revoked_at IS NULL
    AND NEW.enrolled_at >= OLD.created_at AND NEW.enrolled_at <= clock_timestamp()
    AND NEW.enrolled_at < OLD.challenge_expires_at AND OLD.challenge_expires_at > clock_timestamp() THEN
    RETURN NEW;
  END IF;
  IF OLD.state IN ('pending', 'enrolled') AND NEW.state = 'revoked'
    AND NEW.enrolled_at IS NOT DISTINCT FROM OLD.enrolled_at
    AND NEW.revoked_at >= OLD.created_at AND NEW.revoked_at <= clock_timestamp() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'MCP worker enrollment transition is blocked';
END $$;
