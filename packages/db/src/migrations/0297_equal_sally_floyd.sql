CREATE TABLE "mcp_worker_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"controller_instance_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"key_id" text NOT NULL,
	"public_key" text NOT NULL,
	"gateway_url" text NOT NULL,
	"execution_host_id" text NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"bootstrap_token_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"challenge_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"enrolled_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_worker_enrollments_state_ck" CHECK ("mcp_worker_enrollments"."state" in ('pending', 'enrolled', 'revoked')),
	CONSTRAINT "mcp_worker_enrollments_hash_ck" CHECK ("mcp_worker_enrollments"."bootstrap_token_hash" ~ '^[a-f0-9]{64}$' and "mcp_worker_enrollments"."nonce" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "mcp_worker_enrollments_expiry_ck" CHECK ("mcp_worker_enrollments"."challenge_expires_at" > "mcp_worker_enrollments"."created_at" and "mcp_worker_enrollments"."challenge_expires_at" <= "mcp_worker_enrollments"."expires_at" and
    "mcp_worker_enrollments"."challenge_expires_at" <= "mcp_worker_enrollments"."created_at" + interval '5 minutes' and "mcp_worker_enrollments"."expires_at" <= "mcp_worker_enrollments"."created_at" + interval '720 hours'),
	CONSTRAINT "mcp_worker_enrollments_acceptance_ck" CHECK (
    ("mcp_worker_enrollments"."state" = 'pending' and "mcp_worker_enrollments"."enrolled_at" is null and "mcp_worker_enrollments"."revoked_at" is null) or
    ("mcp_worker_enrollments"."state" = 'enrolled' and "mcp_worker_enrollments"."enrolled_at" is not null and "mcp_worker_enrollments"."revoked_at" is null) or
    ("mcp_worker_enrollments"."state" = 'revoked' and "mcp_worker_enrollments"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "mcp_worker_enrollments" ADD CONSTRAINT "mcp_worker_enrollments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_worker_enrollments_key_uq" ON "mcp_worker_enrollments" USING btree ("company_id","worker_id","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_worker_enrollments_live_worker_uq" ON "mcp_worker_enrollments" USING btree ("company_id","worker_id") WHERE "mcp_worker_enrollments"."state" <> 'revoked';--> statement-breakpoint
CREATE INDEX "mcp_worker_enrollments_company_idx" ON "mcp_worker_enrollments" USING btree ("company_id");
--> statement-breakpoint
-- Preserve pins and key-label tombstones independently of run recovery ownership.
-- No application setting permits reactivation, pin substitution or deletion.
CREATE FUNCTION guard_mcp_worker_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MCP worker enrollment tombstone must be retained';
  END IF;
  IF TG_OP = 'INSERT' THEN
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
--> statement-breakpoint
CREATE TRIGGER guard_mcp_worker_enrollment BEFORE INSERT OR UPDATE OR DELETE ON "mcp_worker_enrollments"
  FOR EACH ROW EXECUTE FUNCTION guard_mcp_worker_enrollment();
