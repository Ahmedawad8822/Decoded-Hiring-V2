CREATE TABLE `editorial_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `editorial_audit_log_entity_idx` ON `editorial_audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `editorial_audit_log_actor_idx` ON `editorial_audit_log` (`actor`);--> statement-breakpoint
CREATE TABLE `editorial_draft_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`source_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`rank` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `editorial_drafts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chunk_id`) REFERENCES `knowledge_chunks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `editorial_draft_sources_draft_idx` ON `editorial_draft_sources` (`draft_id`);--> statement-breakpoint
CREATE INDEX `editorial_draft_sources_chunk_idx` ON `editorial_draft_sources` (`chunk_id`);--> statement-breakpoint
CREATE TABLE `editorial_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`content_type` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`excerpt` text,
	`body` text NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`skill_id` text NOT NULL,
	`skill_version` text NOT NULL,
	`provider` text,
	`model` text,
	`created_by` text NOT NULL,
	`reviewed_by` text,
	`approved_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`submitted_at` integer,
	`approved_at` integer,
	`rejected_at` integer,
	`published_at` integer,
	`published_entity_id` text,
	`published_entity_type` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `editorial_drafts_published_entity_unique` ON `editorial_drafts` (`published_entity_id`);--> statement-breakpoint
CREATE INDEX `editorial_drafts_status_idx` ON `editorial_drafts` (`status`);--> statement-breakpoint
CREATE INDEX `editorial_drafts_content_type_idx` ON `editorial_drafts` (`content_type`);--> statement-breakpoint
CREATE TABLE `editorial_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`content` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `editorial_memory_category_idx` ON `editorial_memory` (`category`);--> statement-breakpoint
CREATE INDEX `editorial_memory_active_idx` ON `editorial_memory` (`active`);--> statement-breakpoint
CREATE TABLE `knowledge_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`heading` text,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`character_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_sources` (`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `knowledge_chunks_source_idx` ON `knowledge_chunks` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_chunks_source_ordinal_unique` ON `knowledge_chunks` (`source_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `knowledge_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`source_type` text NOT NULL,
	`mime_type` text NOT NULL,
	`original_filename` text NOT NULL,
	`r2_key` text NOT NULL,
	`author` text,
	`source_label` text,
	`notes` text,
	`status` text DEFAULT 'UPLOADED' NOT NULL,
	`checksum` text NOT NULL,
	`byte_size` integer NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ingested_at` integer,
	`error` text,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_sources_r2_key_unique` ON `knowledge_sources` (`r2_key`);--> statement-breakpoint
CREATE INDEX `knowledge_sources_status_idx` ON `knowledge_sources` (`status`);--> statement-breakpoint
CREATE INDEX `knowledge_sources_checksum_idx` ON `knowledge_sources` (`checksum`);--> statement-breakpoint
-- FTS5 external-content full-text index over knowledge_chunks (Mission 07).
-- Drizzle does not manage SQLite virtual-table semantics, so this is a
-- hand-authored custom SQL migration. The triggers keep the index in sync
-- with knowledge_chunks inserts/updates/deletes. The snapshot/journal track
-- only the Drizzle-managed base tables; this virtual table is SQL-managed only.
CREATE VIRTUAL TABLE `knowledge_chunks_fts` USING fts5(`content`, `heading`, content='knowledge_chunks', content_rowid='rowid');--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_ai` AFTER INSERT ON `knowledge_chunks` BEGIN
  INSERT INTO `knowledge_chunks_fts` (`rowid`, `content`, `heading`) VALUES (new.`rowid`, new.`content`, new.`heading`);
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_ad` AFTER DELETE ON `knowledge_chunks` BEGIN
  INSERT INTO `knowledge_chunks_fts` (`knowledge_chunks_fts`, `rowid`, `content`, `heading`) VALUES ('delete', old.`rowid`, old.`content`, old.`heading`);
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_au` AFTER UPDATE ON `knowledge_chunks` BEGIN
  INSERT INTO `knowledge_chunks_fts` (`knowledge_chunks_fts`, `rowid`, `content`, `heading`) VALUES ('delete', old.`rowid`, old.`content`, old.`heading`);
  INSERT INTO `knowledge_chunks_fts` (`rowid`, `content`, `heading`) VALUES (new.`rowid`, new.`content`, new.`heading`);
END;--> statement-breakpoint
-- Pre-seeded editorial memory (Mission 07 §4). These ship with every fresh
-- database. INSERT OR IGNORE guards against double-application in test
-- environments where migrations may be re-run against the same D1 file.
INSERT OR IGNORE INTO `editorial_memory` (`id`, `category`, `content`, `active`, `created_by`, `created_at`, `updated_at`, `archived_at`) VALUES
  ('mem_001', 'POSITIONING', 'Decoded teaches builders to ship production features, not consume tutorials. Every insight must lead to an action the reader can take in their codebase today.', 1, 'system', 1726684800000, 1726684800000, NULL),
  ('mem_002', 'POSITIONING', 'Decoded''s content is GCC-audited: claims about compiler behavior, runtime internals, or toolchain mechanics are verified against the actual toolchain before publication.', 1, 'system', 1726684800000, 1726684800000, NULL),
  ('mem_003', 'VOICE', 'Write like a senior engineer who has shipped the thing they''re describing — confident, precise, never salesy. Avoid marketing fluff; cite evidence by name.', 1, 'system', 1726684800000, 1726684800000, NULL),
  ('mem_004', 'AUDIENCE', 'Audience: working developers and architects building production systems. Assume deep technical knowledge but not familiarity with the specific problem space.', 1, 'system', 1726684800000, 1726684800000, NULL),
  ('mem_005', 'METHODOLOGY', 'Aha Authority format: lead with an unexpected insight, ground every claim in evidence, then provide a concrete next step. Never lead with context-setting.', 1, 'system', 1726684800000, 1726684800000, NULL),
  ('mem_006', 'EDITORIAL_RULE', 'Never embed raw Markdown, HTML, or code blocks in output — only structured content blocks (headings, paragraphs, blockquotes, callouts, lists).', 1, 'system', 1726684800000, 1726684800000, NULL),
  ('mem_007', 'AVOID', 'Avoid: in todays tutorial, lets build together, filler phrases, promises about future content, and any instruction to imagine or pretend.', 1, 'system', 1726684800000, 1726684800000, NULL),
  ('mem_008', 'AVOID', 'Never reproduce full source material verbatim — summarize, paraphrase, and cite by name.', 1, 'system', 1726684800000, 1726684800000, NULL),
  ('mem_009', 'GCC_CONTEXT', 'GCC-specific: compiler internals discussed must reference the specific GCC version (e.g. GCC 13+) and source files in gcc/ subdirectory, not general documentation.', 1, 'system', 1726684800000, 1726684800000, NULL),
  ('mem_010', 'EDITORIAL_RULE', 'Callout blocks with tone evidence must cite the source title in the label field. Blockquote blocks are for direct paraphrase attribution.', 1, 'system', 1726684800000, 1726684800000, NULL);--> statement-breakpoint
