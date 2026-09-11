-- The documented IG User `tags` edge (owned account) gets its
-- own append-only table — media owned by OTHER accounts in which this account
-- was tagged. First-observation-wins (no UPDATE trigger below), no removal or
-- diff claim is ever derived, and a tag row is never rendered as the account's
-- own media. Also here: the documented IG Media `reposts_count` scalar gets a
-- nullable posts column — parsed when a provider actually returns it, NULL
-- otherwise, never zero-filled, and never requested on a live edge until the
-- recorded live verification happens.
CREATE TABLE "tagged_media" (
	"id" text PRIMARY KEY NOT NULL,
	"ig_account_id" text NOT NULL,
	"source_id" text NOT NULL,
	"media_id" text NOT NULL,
	"owner_username" text,
	"caption" text,
	"permalink" text,
	"media_type" text,
	"taken_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "reposts_count" integer;--> statement-breakpoint
ALTER TABLE "tagged_media" ADD CONSTRAINT "tagged_media_ig_account_id_ig_accounts_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tagged_media" ADD CONSTRAINT "tagged_media_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tagged_media" ADD CONSTRAINT "tagged_media_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tagged_media_idempotency_idx" ON "tagged_media" USING btree ("ig_account_id","media_id","source_id");--> statement-breakpoint
CREATE INDEX "tagged_media_account_time_idx" ON "tagged_media" USING btree ("ig_account_id","observed_at");--> statement-breakpoint
CREATE TRIGGER "tagged_media_no_update" BEFORE UPDATE ON "tagged_media" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();
