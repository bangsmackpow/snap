CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`transaction_id` text,
	`batch_id` text,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_transaction_idx` ON `audit_log` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `category_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`match_on` text DEFAULT 'vendor' NOT NULL,
	`keyword` text NOT NULL,
	`account` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `category_rules_priority_idx` ON `category_rules` (`priority`,`active`);--> statement-breakpoint
CREATE TABLE `magic_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `magic_links_token_idx` ON `magic_links` (`token_hash`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `flagged` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `flag_reason` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `verified_at` integer;--> statement-breakpoint
ALTER TABLE `transactions` ADD `verified_by` text;--> statement-breakpoint
CREATE INDEX `transactions_flagged_idx` ON `transactions` (`flagged`);