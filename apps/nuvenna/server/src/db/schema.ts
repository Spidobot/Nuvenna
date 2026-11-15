// Nuvenna tables (CONCEPT.md §4 "Nuvenna"), prefixed "pages_".
import type { CoreDb } from "@tvn/core";
import type { Generated } from "kysely";

export type SpaceGrantee = "group" | "user" | "anyone" | "logged_in";
export type RestrictionGrantee = "group" | "user";

interface PagesTables {
  pages_space: {
    id: string;
    space_key: string;
    name: string;
    description: string;
    home_page_id: string | null;
    archived: boolean;
    /** Offered to customers in the portal (V-5). */
    knowledge_base: Generated<boolean>;
    created_at: Date;
  };
  pages_space_permission: {
    id: string;
    space_id: string;
    permission: string;
    grantee_type: SpaceGrantee;
    grantee_id: string | null;
  };
  pages_page: {
    id: string;
    space_id: string;
    parent_id: string | null;
    position: number;
    title: string;
    kind: "page" | "blog" | "template";
    status: "current" | "trashed";
    version: number;
    content_json: string;
    content_text: string;
    created_by: string;
    created_at: Date;
    updated_by: string;
    updated_at: Date;
    trashed_at: Date | null;
  };
  pages_page_ydoc: { page_id: string; state: Buffer; updated_at: Date };
  pages_page_version: {
    id: string;
    page_id: string;
    number: number;
    title: string;
    content_json: string;
    author_id: string;
    message: string | null;
    created_at: Date;
  };
  pages_page_restriction: {
    id: string;
    page_id: string;
    kind: "view" | "edit";
    grantee_type: RestrictionGrantee;
    grantee_id: string;
  };
  pages_page_comment: {
    id: string;
    page_id: string;
    parent_id: string | null;
    anchor_json: string | null;
    body_json: string;
    body_text: string;
    author_id: string;
    resolved: boolean;
    created_at: Date;
    updated_at: Date;
  };
  pages_page_label: { page_id: string; label: string };
  pages_page_visit: { page_id: string; user_id: string; visited_at: Date };
  pages_page_watch: { page_id: string; user_id: string };
  pages_page_favorite: { page_id: string; user_id: string; created_at: Date };
  pages_page_like: { page_id: string; user_id: string; created_at: Date };
  pages_public_share: {
    id: string;
    page_id: string;
    token_hash: string;
    expires_at: Date | null;
    created_by: string;
    created_at: Date;
  };
}

export type PagesDb = CoreDb & PagesTables;
