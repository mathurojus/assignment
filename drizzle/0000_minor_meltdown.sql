CREATE TYPE "public"."generation_status" AS ENUM('queued', 'submitting', 'generating', 'downloading', 'completed', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."generation_type" AS ENUM('video', 'image');--> statement-breakpoint
CREATE TYPE "public"."ledger_reason" AS ENUM('signup_grant', 'job_reserve', 'job_refund', 'job_reconcile', 'admin_adjust', 'admin_topup');--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credit_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"generation_id" uuid,
	"delta" bigint NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"balance_after" bigint NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_delta_nonzero" CHECK ("credit_ledger"."delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "daily_spend" (
	"day" timestamp with time zone PRIMARY KEY NOT NULL,
	"spent_micro" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "generation_type" NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"enhanced_prompt" text,
	"preset" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "generation_status" DEFAULT 'queued' NOT NULL,
	"openrouter_job_id" text,
	"polling_url" text,
	"error" text,
	"output_url" text,
	"source_image_url" text,
	"mime_type" text,
	"bytes" integer,
	"cost_estimate_micro" bigint DEFAULT 0 NOT NULL,
	"cost_actual_micro" bigint,
	"credits_held" bigint DEFAULT 0 NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "generations_estimate_non_negative" CHECK ("generations"."cost_estimate_micro" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"user_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_count_non_negative" CHECK ("rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"credits" bigint DEFAULT 0 NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"spend_blocked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_credits_non_negative" CHECK ("users"."credits" >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_user_created_idx" ON "credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_generation_idx" ON "credit_ledger" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "generations_user_created_idx" ON "generations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "generations_due_idx" ON "generations" USING btree ("next_poll_at") WHERE "generations"."status" in ('queued','submitting','generating','downloading');--> statement-breakpoint
CREATE INDEX "generations_status_idx" ON "generations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "generations_public_created_idx" ON "generations" USING btree ("created_at") WHERE "generations"."is_public" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "generations_job_key" ON "generations" USING btree ("openrouter_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limits_pk" ON "rate_limits" USING btree ("user_id","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");