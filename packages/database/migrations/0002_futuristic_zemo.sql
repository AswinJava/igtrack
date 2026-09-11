ALTER TABLE "ig_accounts" ALTER COLUMN "is_private" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ig_accounts" ALTER COLUMN "is_private" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ig_accounts" ALTER COLUMN "is_verified" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ig_accounts" ALTER COLUMN "is_verified" DROP NOT NULL;