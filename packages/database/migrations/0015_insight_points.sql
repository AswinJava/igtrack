-- Own-account insights ledger. Value XOR reason (invariant 1): a row is either
-- a measured metric or a documented absence, never a zero-filled stand-in.
CREATE TABLE "insight_points" (
	"id" text PRIMARY KEY NOT NULL,
	"ig_account_id" text NOT NULL,
	"source_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"period" text NOT NULL,
	"timeframe" text,
	"dimension" text,
	"dimension_value" text,
	"end_time" timestamp with time zone,
	"value" double precision,
	"unavailable_reason" text,
	"confidence" "confidence_level" NOT NULL,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "insight_points" ADD CONSTRAINT "insight_points_ig_account_id_ig_accounts_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_points" ADD CONSTRAINT "insight_points_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_points" ADD CONSTRAINT "insight_points_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_points" ADD CONSTRAINT "insight_points_value_xor_reason_chk" CHECK (("insight_points"."value" IS NULL) <> ("insight_points"."unavailable_reason" IS NULL));--> statement-breakpoint
-- NULLs are distinct in unique indexes: coalesce the nullable identity columns
-- or a retried scan would duplicate every absence and every dimension-less point.
CREATE UNIQUE INDEX "insight_points_idempotency_idx" ON "insight_points" USING btree ("ig_account_id","source_id","observed_at","metric","period",coalesce("timeframe", ''),coalesce("dimension", ''),coalesce("dimension_value", ''),coalesce("end_time", 'epoch'::timestamptz));--> statement-breakpoint
CREATE INDEX "insight_points_account_metric_idx" ON "insight_points" USING btree ("ig_account_id","metric","observed_at");--> statement-breakpoint
-- Append-only: a recorded metric value is evidence and must never be rewritten.
CREATE TRIGGER "insight_points_no_update" BEFORE UPDATE ON "insight_points" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();
