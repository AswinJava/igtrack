CREATE TABLE "post_children" (
	"id" text PRIMARY KEY NOT NULL,
	"post_db_id" text NOT NULL,
	"position" integer NOT NULL,
	"child_media_id" text NOT NULL,
	"media_type" text,
	"shortcode" text,
	"permalink" text,
	"taken_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "post_children" ADD CONSTRAINT "post_children_post_db_id_posts_id_fk" FOREIGN KEY ("post_db_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_children_post_child_idx" ON "post_children" USING btree ("post_db_id","child_media_id");--> statement-breakpoint
CREATE TRIGGER "post_children_no_update" BEFORE UPDATE ON "post_children" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();
