CREATE TABLE "adapter_session_affinities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"scope_key" text NOT NULL,
	"task_key" text,
	"endpoint" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adapter_session_affinities" ADD CONSTRAINT "adapter_session_affinities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_session_affinities" ADD CONSTRAINT "adapter_session_affinities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_session_affinities_scope_uniq" ON "adapter_session_affinities" USING btree ("company_id","agent_id","adapter_type","scope_key");--> statement-breakpoint
CREATE INDEX "adapter_session_affinities_agent_idx" ON "adapter_session_affinities" USING btree ("company_id","agent_id");