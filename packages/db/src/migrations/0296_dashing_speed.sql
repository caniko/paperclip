CREATE TABLE "mcp_prepared_launches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid,
	"project_id" uuid,
	"controller_boot_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"launch_digest" text NOT NULL,
	"material" jsonb NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"nonce" text,
	"challenge_expires_at" timestamp with time zone,
	"authorized_at" timestamp with time zone,
	"dispatch_claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_prepared_launches_generation_ck" CHECK ("mcp_prepared_launches"."generation" > 0),
	CONSTRAINT "mcp_prepared_launches_digest_ck" CHECK ("mcp_prepared_launches"."launch_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "mcp_prepared_launches_state_ck" CHECK ("mcp_prepared_launches"."state" in ('prepared', 'authorized', 'dispatching', 'revoked')),
	CONSTRAINT "mcp_prepared_launches_challenge_ck" CHECK (("mcp_prepared_launches"."nonce" is null and "mcp_prepared_launches"."challenge_expires_at" is null) or ("mcp_prepared_launches"."nonce" is not null and "mcp_prepared_launches"."nonce" ~ '^[a-f0-9]{64}$' and "mcp_prepared_launches"."challenge_expires_at" is not null)),
	CONSTRAINT "mcp_prepared_launches_acceptance_ck" CHECK ("mcp_prepared_launches"."state" = 'revoked' or
    ("mcp_prepared_launches"."state" = 'prepared' and "mcp_prepared_launches"."authorized_at" is null and "mcp_prepared_launches"."dispatch_claimed_at" is null) or
    ("mcp_prepared_launches"."state" = 'authorized' and "mcp_prepared_launches"."nonce" is not null and "mcp_prepared_launches"."authorized_at" is not null and "mcp_prepared_launches"."dispatch_claimed_at" is null) or
    ("mcp_prepared_launches"."state" = 'dispatching' and "mcp_prepared_launches"."nonce" is not null and "mcp_prepared_launches"."authorized_at" is not null and "mcp_prepared_launches"."dispatch_claimed_at" is not null))
);
--> statement-breakpoint
-- Establish referenced unique constraints before Drizzle's generated foreign keys.
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_agent_id_uq" UNIQUE("company_id","agent_id","id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "mcp_prepared_launches" ADD CONSTRAINT "mcp_prepared_launches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_prepared_launches" ADD CONSTRAINT "mcp_prepared_launches_run_owner_fk" FOREIGN KEY ("company_id","agent_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_prepared_launches" ADD CONSTRAINT "mcp_prepared_launches_issue_owner_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_prepared_launches" ADD CONSTRAINT "mcp_prepared_launches_project_owner_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_prepared_launches_run_uq" ON "mcp_prepared_launches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "mcp_prepared_launches_company_expiry_idx" ON "mcp_prepared_launches" USING btree ("company_id","expires_at");
