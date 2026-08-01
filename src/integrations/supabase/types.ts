export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      attachments: {
        Row: {
          content_base64: string | null;
          content_disposition: string | null;
          content_id: string | null;
          filename: string;
          id: string;
          message_id: string;
          mime: string | null;
          size: number;
          storage_path: string;
        };
        Insert: {
          content_base64?: string | null;
          content_disposition?: string | null;
          content_id?: string | null;
          filename: string;
          id?: string;
          message_id: string;
          mime?: string | null;
          size?: number;
          storage_path: string;
        };
        Update: {
          content_base64?: string | null;
          content_disposition?: string | null;
          content_id?: string | null;
          filename?: string;
          id?: string;
          message_id?: string;
          mime?: string | null;
          size?: number;
          storage_path?: string;
        };
        Relationships: [
          {
            foreignKeyName: "attachments_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      blocked_senders: {
        Row: {
          created_at: string;
          id: string;
          mailbox_id: string | null;
          match_type: string;
          match_value: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          mailbox_id?: string | null;
          match_type: string;
          match_value: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          mailbox_id?: string | null;
          match_type?: string;
          match_value?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "blocked_senders_mailbox_id_fkey";
            columns: ["mailbox_id"];
            isOneToOne: false;
            referencedRelation: "mailboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      dm_attachments: {
        Row: {
          dm_id: string;
          filename: string;
          id: string;
          mime: string | null;
          size: number;
          storage_path: string;
        };
        Insert: {
          dm_id: string;
          filename: string;
          id?: string;
          mime?: string | null;
          size?: number;
          storage_path: string;
        };
        Update: {
          dm_id?: string;
          filename?: string;
          id?: string;
          mime?: string | null;
          size?: number;
          storage_path?: string;
        };
        Relationships: [
          {
            foreignKeyName: "dm_attachments_dm_id_fkey";
            columns: ["dm_id"];
            isOneToOne: false;
            referencedRelation: "dms";
            referencedColumns: ["id"];
          },
        ];
      };
      dm_threads: {
        Row: {
          id: string;
          last_at: string;
          user_a: string;
          user_b: string;
        };
        Insert: {
          id?: string;
          last_at?: string;
          user_a: string;
          user_b: string;
        };
        Update: {
          id?: string;
          last_at?: string;
          user_a?: string;
          user_b?: string;
        };
        Relationships: [];
      };
      dms: {
        Row: {
          body: string;
          created_at: string;
          deleted: boolean;
          edited_at: string | null;
          id: string;
          recipient_id: string;
          seen_at: string | null;
          sender_id: string;
          thread_id: string;
        };
        Insert: {
          body: string;
          created_at?: string;
          deleted?: boolean;
          edited_at?: string | null;
          id?: string;
          recipient_id: string;
          seen_at?: string | null;
          sender_id: string;
          thread_id: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          deleted?: boolean;
          edited_at?: string | null;
          id?: string;
          recipient_id?: string;
          seen_at?: string | null;
          sender_id?: string;
          thread_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "dms_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: false;
            referencedRelation: "dm_threads";
            referencedColumns: ["id"];
          },
        ];
      };
      domains: {
        Row: {
          created_at: string;
          expires_at: string | null;
          id: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          name: string;
        };
        Update: {
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          name?: string;
        };
        Relationships: [];
      };
      drafts: {
        Row: {
          bcc: string | null;
          body: string | null;
          cc: string | null;
          from_mailbox_id: string | null;
          id: string;
          in_reply_to: string | null;
          subject: string | null;
          to_addr: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          bcc?: string | null;
          body?: string | null;
          cc?: string | null;
          from_mailbox_id?: string | null;
          id?: string;
          in_reply_to?: string | null;
          subject?: string | null;
          to_addr?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          bcc?: string | null;
          body?: string | null;
          cc?: string | null;
          from_mailbox_id?: string | null;
          id?: string;
          in_reply_to?: string | null;
          subject?: string | null;
          to_addr?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "drafts_from_mailbox_id_fkey";
            columns: ["from_mailbox_id"];
            isOneToOne: false;
            referencedRelation: "mailboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      labels: {
        Row: {
          color: string;
          created_at: string;
          id: string;
          name: string;
          user_id: string;
        };
        Insert: {
          color?: string;
          created_at?: string;
          id?: string;
          name: string;
          user_id: string;
        };
        Update: {
          color?: string;
          created_at?: string;
          id?: string;
          name?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      mailboxes: {
        Row: {
          auto_bcc: string | null;
          created_at: string;
          default_reply_mode: string;
          display_name: string | null;
          domain_id: string;
          expires_at: string | null;
          hidden: boolean;
          id: string;
          is_temp: boolean;
          local_part: string;
          signature: string | null;
          signature_placement: string;
          user_id: string;
        };
        Insert: {
          auto_bcc?: string | null;
          created_at?: string;
          default_reply_mode?: string;
          display_name?: string | null;
          domain_id: string;
          expires_at?: string | null;
          hidden?: boolean;
          id?: string;
          is_temp?: boolean;
          local_part: string;
          signature?: string | null;
          signature_placement?: string;
          user_id: string;
        };
        Update: {
          auto_bcc?: string | null;
          created_at?: string;
          default_reply_mode?: string;
          display_name?: string | null;
          domain_id?: string;
          expires_at?: string | null;
          hidden?: boolean;
          id?: string;
          is_temp?: boolean;
          local_part?: string;
          signature?: string | null;
          signature_placement?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "mailboxes_domain_id_fkey";
            columns: ["domain_id"];
            isOneToOne: false;
            referencedRelation: "domains";
            referencedColumns: ["id"];
          },
        ];
      };
      message_labels: {
        Row: {
          label_id: string;
          message_id: string;
        };
        Insert: {
          label_id: string;
          message_id: string;
        };
        Update: {
          label_id?: string;
          message_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_labels_label_id_fkey";
            columns: ["label_id"];
            isOneToOne: false;
            referencedRelation: "labels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_labels_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          body_html: string | null;
          body_text: string | null;
          folder: string;
          id: string;
          in_reply_to: string | null;
          mailbox_id: string;
          message_id: string | null;
          raw: string | null;
          received_at: string;
          recipient_addr: string;
          seen: boolean;
          sender: string;
          size_bytes: number;
          snoozed_until: string | null;
          starred: boolean;
          subject: string | null;
          thread_id: string | null;
        };
        Insert: {
          body_html?: string | null;
          body_text?: string | null;
          folder?: string;
          id?: string;
          in_reply_to?: string | null;
          mailbox_id: string;
          message_id?: string | null;
          raw?: string | null;
          received_at?: string;
          recipient_addr: string;
          seen?: boolean;
          sender: string;
          size_bytes?: number;
          snoozed_until?: string | null;
          starred?: boolean;
          subject?: string | null;
          thread_id?: string | null;
        };
        Update: {
          body_html?: string | null;
          body_text?: string | null;
          folder?: string;
          id?: string;
          in_reply_to?: string | null;
          mailbox_id?: string;
          message_id?: string | null;
          raw?: string | null;
          received_at?: string;
          recipient_addr?: string;
          seen?: boolean;
          sender?: string;
          size_bytes?: number;
          snoozed_until?: string | null;
          starred?: boolean;
          subject?: string | null;
          thread_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "messages_mailbox_id_fkey";
            columns: ["mailbox_id"];
            isOneToOne: false;
            referencedRelation: "mailboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      api_keys: {
        Row: {
          created_at: string;
          id: string;
          key_hash: string;
          key_prefix: string;
          last_used_at: string | null;
          name: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          key_hash: string;
          key_prefix: string;
          last_used_at?: string | null;
          name: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          key_hash?: string;
          key_prefix?: string;
          last_used_at?: string | null;
          name?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      api_mailboxes: {
        Row: { created_at: string; mailbox_id: string; user_id: string };
        Insert: { created_at?: string; mailbox_id: string; user_id: string };
        Update: { created_at?: string; mailbox_id?: string; user_id?: string };
        Relationships: [
          {
            foreignKeyName: "api_mailboxes_mailbox_id_fkey";
            columns: ["mailbox_id"];
            isOneToOne: true;
            referencedRelation: "mailboxes";
            referencedColumns: ["id"];
          },
        ];
      };
      guest_sessions: {
        Row: {
          cleanup_secret_hash: string;
          delete_after: string | null;
          expires_at: string;
          last_seen_at: string;
          user_id: string;
        };
        Insert: {
          cleanup_secret_hash: string;
          delete_after?: string | null;
          expires_at: string;
          last_seen_at?: string;
          user_id: string;
        };
        Update: {
          cleanup_secret_hash?: string;
          delete_after?: string | null;
          expires_at?: string;
          last_seen_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          account_kind: string;
          api_access: boolean;
          created_at: string;
          density: string;
          display_name: string | null;
          dm_privacy: string;
          guest_expires_at: string | null;
          mailbox_limit: number;
          suspended_until: string | null;
          user_id: string;
          username: string;
        };
        Insert: {
          account_kind?: string;
          api_access?: boolean;
          created_at?: string;
          density?: string;
          display_name?: string | null;
          dm_privacy?: string;
          guest_expires_at?: string | null;
          mailbox_limit?: number;
          suspended_until?: string | null;
          user_id: string;
          username: string;
        };
        Update: {
          account_kind?: string;
          api_access?: boolean;
          created_at?: string;
          density?: string;
          display_name?: string | null;
          dm_privacy?: string;
          guest_expires_at?: string | null;
          mailbox_limit?: number;
          suspended_until?: string | null;
          user_id?: string;
          username?: string;
        };
        Relationships: [];
      };
      settings: {
        Row: {
          key: string;
          updated_at: string;
          value: Json;
        };
        Insert: {
          key: string;
          updated_at?: string;
          value: Json;
        };
        Update: {
          key?: string;
          updated_at?: string;
          value?: Json;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      create_block_rule: {
        Args: { p_mailbox_id?: string | null; p_match_type: string; p_match_value: string };
        Returns: string;
      };
      admin_set_mailbox_limit: {
        Args: { p_limit: number; p_user_id: string };
        Returns: number;
      };
      admin_set_storage_limits: {
        Args: { p_global_limit_bytes: number; p_mailbox_limit_bytes: number };
        Returns: {
          global_limit_bytes: number;
          mailbox_limit_bytes: number;
        }[];
      };
      admin_user_stats: {
        Args: Record<PropertyKey, never>;
        Returns: {
          addresses: string[];
          created_at: string;
          display_name: string | null;
          mailbox_count: number;
          mailbox_limit: number;
          storage_bytes: number;
          user_id: string;
          username: string;
        }[];
      };
      create_mailbox: {
        Args: {
          p_domain_id: string;
          p_is_temp?: boolean;
          p_local_part: string;
          p_ttl_minutes?: number | null;
        };
        Returns: Database["public"]["Tables"]["mailboxes"]["Row"];
      };
      complete_outbound_delivery: {
        Args: {
          p_accepted_count?: number;
          p_error_code?: string | null;
          p_id: string;
          p_rejected_count?: number;
          p_relay_message_id?: string | null;
          p_status: string;
          p_user_id: string;
        };
        Returns: boolean;
      };
      delete_mailbox: {
        Args: { p_mailbox_id: string };
        Returns: string;
      };
      delete_domain: {
        Args: { p_domain_id: string };
        Returns: string;
      };
      get_my_profile: {
        Args: Record<PropertyKey, never>;
        Returns: Database["public"]["Tables"]["profiles"]["Row"];
      };
      get_jellyfin_runtime_configuration: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      get_smtp_runtime_configuration: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      list_dm_profiles: {
        Args: Record<PropertyKey, never>;
        Returns: {
          display_name: string | null;
          user_id: string;
          username: string;
        }[];
      };
      mark_dm_thread_seen: {
        Args: { p_thread_id: string };
        Returns: number;
      };
      purge_expired_mailboxes: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      reserve_outbound_delivery: {
        Args: {
          p_id: string;
          p_mailbox_id: string;
          p_recipient_count: number;
          p_user_id: string;
        };
        Returns: string;
      };
      search_dm_profiles: {
        Args: { p_limit?: number; p_query: string };
        Returns: {
          display_name: string | null;
          user_id: string;
          username: string;
        }[];
      };
      send_dm: {
        Args: { p_body: string; p_thread_id: string };
        Returns: Database["public"]["Tables"]["dms"]["Row"];
      };
      set_jellyfin_runtime_configuration: {
        Args: {
          p_api_key_encrypted: string | null;
          p_enabled: boolean;
          p_expected_revision: number;
          p_managed: boolean;
          p_updated_by: string;
          p_url: string | null;
        };
        Returns: Json;
      };
      set_smtp_runtime_configuration: {
        Args: {
          p_enabled: boolean;
          p_expected_revision: number;
          p_host: string | null;
          p_managed: boolean;
          p_max_recipients: number;
          p_password_encrypted: string | null;
          p_port: number;
          p_security: string;
          p_updated_by: string;
          p_username: string | null;
        };
        Returns: Json;
      };
      set_mailbox_lifetime: {
        Args: { p_mailbox_id: string; p_ttl_minutes?: number | null };
        Returns: Database["public"]["Tables"]["mailboxes"]["Row"];
      };
      set_mailbox_remaining: {
        Args: { p_mailbox_id: string; p_ttl_minutes: number };
        Returns: Database["public"]["Tables"]["mailboxes"]["Row"];
      };
      start_dm_thread: {
        Args: { p_username: string };
        Returns: string;
      };
      start_dm_thread_by_user: {
        Args: { p_user_id: string };
        Returns: string;
      };
      store_inbound_delivery: {
        Args: { p_attachments: Json; p_messages: Json };
        Returns: {
          attachments: number;
          messages: number;
        }[];
      };
    };
    Enums: {
      app_role: "admin" | "user";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const;
