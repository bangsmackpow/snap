CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_type` text NOT NULL,
	`r2_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`extraction_json` text,
	`extraction_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `documents_type_status_idx` ON `documents` (`doc_type`,`status`);--> statement-breakpoint
CREATE TABLE `export_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`exported_by` text NOT NULL,
	`file_r2_key` text NOT NULL,
	`record_count` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_role` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`check_doc_id` text,
	`invoice_doc_id` text,
	`vendor_payee` text,
	`amount` integer,
	`transaction_date` integer,
	`check_number` text,
	`memo` text,
	`category_code` text,
	`confidence_score` integer,
	`status` text DEFAULT 'unpaired' NOT NULL,
	`exported_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`check_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`invoice_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `transactions_status_idx` ON `transactions` (`status`);--> statement-breakpoint
CREATE INDEX `transactions_check_doc_idx` ON `transactions` (`check_doc_id`);--> statement-breakpoint
CREATE INDEX `transactions_invoice_doc_idx` ON `transactions` (`invoice_doc_id`);