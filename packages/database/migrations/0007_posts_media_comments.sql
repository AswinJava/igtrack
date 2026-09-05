CREATE TYPE "media_type_v2" AS ENUM('IMAGE', 'VIDEO', 'CAROUSEL', 'UNKNOWN');--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "media_type" TYPE "media_type_v2" USING "media_type"::text::"media_type_v2";--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "media_type" TYPE "media_type_v2" USING "media_type"::text::"media_type_v2";--> statement-breakpoint
DROP TYPE "media_type";--> statement-breakpoint
ALTER TYPE "media_type_v2" RENAME TO "media_type";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "media_type" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "media_product_type" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "comments_state" text;--> statement-breakpoint
ALTER TABLE "post_comments" ADD COLUMN "in_reply_to_comment_id" text;
