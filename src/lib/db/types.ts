// ============================================================
// Auto-generated from Supabase — do not edit the Database
// block by hand. Re-run: npx supabase gen types typescript
//   --project-id skrygwigeschidsspbpi > src/lib/db/types.ts
// ============================================================

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          hash: string
          id: string
          payload: Json | null
          prev_hash: string | null
          writeoff_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          hash: string
          id?: string
          payload?: Json | null
          prev_hash?: string | null
          writeoff_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          hash?: string
          id?: string
          payload?: Json | null
          prev_hash?: string | null
          writeoff_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_writeoff_id_fkey"
            columns: ["writeoff_id"]
            isOneToOne: false
            referencedRelation: "writeoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      deductions: {
        Row: {
          acknowledged_at: string | null
          amount: number
          basis: string
          cap_amount: number | null
          created_at: string
          dispute_reason: string | null
          employee_id: string
          id: string
          signature: string | null
          status: string
          writeoff_id: string
        }
        Insert: {
          acknowledged_at?: string | null
          amount: number
          basis: string
          cap_amount?: number | null
          created_at?: string
          dispute_reason?: string | null
          employee_id: string
          id?: string
          signature?: string | null
          status?: string
          writeoff_id: string
        }
        Update: {
          acknowledged_at?: string | null
          amount?: number
          basis?: string
          cap_amount?: number | null
          created_at?: string
          dispute_reason?: string | null
          employee_id?: string
          id?: string
          signature?: string | null
          status?: string
          writeoff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deductions_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deductions_writeoff_id_fkey"
            columns: ["writeoff_id"]
            isOneToOne: false
            referencedRelation: "writeoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          created_at: string
          full_name: string
          id: string
          location_id: string | null
          material_liability: boolean
          position: string | null
        }
        Insert: {
          created_at?: string
          full_name: string
          id?: string
          location_id?: string | null
          material_liability?: boolean
          position?: string | null
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          location_id?: string | null
          material_liability?: boolean
          position?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      iiko_act_ledger: {
        Row: {
          attempts: number
          created_at: string
          id: string
          idempotency_key: string
          iiko_doc_id: string | null
          last_error: string | null
          request: Json | null
          response: Json | null
          status: string
          writeoff_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          id?: string
          idempotency_key: string
          iiko_doc_id?: string | null
          last_error?: string | null
          request?: Json | null
          response?: Json | null
          status?: string
          writeoff_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: string
          idempotency_key?: string
          iiko_doc_id?: string | null
          last_error?: string | null
          request?: Json | null
          response?: Json | null
          status?: string
          writeoff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "iiko_act_ledger_writeoff_id_fkey"
            columns: ["writeoff_id"]
            isOneToOne: false
            referencedRelation: "writeoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      iiko_nomenclature_map: {
        Row: {
          created_at: string
          id: string
          iiko_account_id: string
          iiko_product_id: string
          iiko_store_id: string
          iiko_unit: string
          product_label: string
          reason_code_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          iiko_account_id: string
          iiko_product_id: string
          iiko_store_id: string
          iiko_unit: string
          product_label: string
          reason_code_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          iiko_account_id?: string
          iiko_product_id?: string
          iiko_store_id?: string
          iiko_unit?: string
          product_label?: string
          reason_code_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "iiko_nomenclature_map_reason_code_id_fkey"
            columns: ["reason_code_id"]
            isOneToOne: false
            referencedRelation: "reason_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          code: string
          created_at: string
          geofence_radius_m: number
          id: string
          iiko_store_id: string | null
          lat: number | null
          lng: number | null
          name: string
        }
        Insert: {
          code: string
          created_at?: string
          geofence_radius_m?: number
          id?: string
          iiko_store_id?: string | null
          lat?: number | null
          lng?: number | null
          name: string
        }
        Update: {
          code?: string
          created_at?: string
          geofence_radius_m?: number
          id?: string
          iiko_store_id?: string | null
          lat?: number | null
          lng?: number | null
          name?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          device_id: string | null
          full_name: string
          id: string
          location_id: string | null
          role: string
        }
        Insert: {
          created_at?: string
          device_id?: string | null
          full_name: string
          id: string
          location_id?: string | null
          role?: string
        }
        Update: {
          created_at?: string
          device_id?: string | null
          full_name?: string
          id?: string
          location_id?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      reason_codes: {
        Row: {
          category: string
          created_at: string
          deduction_default: boolean
          id: string
          key: string
          label_kk: string
          label_ru: string
        }
        Insert: {
          category: string
          created_at?: string
          deduction_default?: boolean
          id?: string
          key: string
          label_kk: string
          label_ru: string
        }
        Update: {
          category?: string
          created_at?: string
          deduction_default?: boolean
          id?: string
          key?: string
          label_kk?: string
          label_ru?: string
        }
        Relationships: []
      }
      risk_events: {
        Row: {
          created_at: string
          detail: Json | null
          feature: string
          id: string
          weight: number
          writeoff_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json | null
          feature: string
          id?: string
          weight?: number
          writeoff_id: string
        }
        Update: {
          created_at?: string
          detail?: Json | null
          feature?: string
          id?: string
          weight?: number
          writeoff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "risk_events_writeoff_id_fkey"
            columns: ["writeoff_id"]
            isOneToOne: false
            referencedRelation: "writeoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      writeoff_photos: {
        Row: {
          captured_at: string | null
          created_at: string
          dup_of: string | null
          exif: Json | null
          gps_lat: number | null
          gps_lng: number | null
          id: string
          phash: string | null
          source: string
          storage_path: string
          vision_result: Json | null
          writeoff_id: string
        }
        Insert: {
          captured_at?: string | null
          created_at?: string
          dup_of?: string | null
          exif?: Json | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          phash?: string | null
          source?: string
          storage_path: string
          vision_result?: Json | null
          writeoff_id: string
        }
        Update: {
          captured_at?: string | null
          created_at?: string
          dup_of?: string | null
          exif?: Json | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          phash?: string | null
          source?: string
          storage_path?: string
          vision_result?: Json | null
          writeoff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "writeoff_photos_dup_of_fkey"
            columns: ["dup_of"]
            isOneToOne: false
            referencedRelation: "writeoff_photos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "writeoff_photos_writeoff_id_fkey"
            columns: ["writeoff_id"]
            isOneToOne: false
            referencedRelation: "writeoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      writeoffs: {
        Row: {
          charged_employee_id: string | null
          comment: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          iiko_sync_status: string
          location_id: string
          qty: number
          reason_code_id: string
          risk_score: number
          status: string
          submitter_id: string
          unit: string
          value_cost: number | null
          withholding: boolean
        }
        Insert: {
          charged_employee_id?: string | null
          comment?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          iiko_sync_status?: string
          location_id: string
          qty: number
          reason_code_id: string
          risk_score?: number
          status?: string
          submitter_id: string
          unit: string
          value_cost?: number | null
          withholding?: boolean
        }
        Update: {
          charged_employee_id?: string | null
          comment?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          iiko_sync_status?: string
          location_id?: string
          qty?: number
          reason_code_id?: string
          risk_score?: number
          status?: string
          submitter_id?: string
          unit?: string
          value_cost?: number | null
          withholding?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "writeoffs_charged_employee_id_fkey"
            columns: ["charged_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "writeoffs_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "writeoffs_reason_code_id_fkey"
            columns: ["reason_code_id"]
            isOneToOne: false
            referencedRelation: "reason_codes"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_my_role: { Args: never; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

// ============================================================
// Domain convenience aliases
// ============================================================

/** Row types — use for read paths */
export type Profile           = Tables<"profiles">
export type Location          = Tables<"locations">
export type Employee          = Tables<"employees">
export type ReasonCode        = Tables<"reason_codes">
export type Writeoff          = Tables<"writeoffs">
export type WriteoffPhoto     = Tables<"writeoff_photos">
export type IikoNomenclature  = Tables<"iiko_nomenclature_map">
export type RiskEvent         = Tables<"risk_events">
export type AuditLog          = Tables<"audit_log">
export type Deduction         = Tables<"deductions">
export type IikoActLedger     = Tables<"iiko_act_ledger">

/** Insert types — use for create paths */
export type WriteoffInsert     = TablesInsert<"writeoffs">
export type WriteoffPhotoInsert = TablesInsert<"writeoff_photos">
export type DeductionInsert    = TablesInsert<"deductions">
export type RiskEventInsert    = TablesInsert<"risk_events">
export type AuditLogInsert     = TablesInsert<"audit_log">
export type IikoActLedgerInsert = TablesInsert<"iiko_act_ledger">

/** Narrow literal union types for status/role columns */
export type UserRole          = "employee" | "reviewer" | "admin"
export type WriteoffStatus    = "draft" | "submitted" | "auto_approved" | "in_review" | "dual_control" | "on_hold" | "approved" | "rejected"
export type ReasonCategory    = "yield" | "quality" | "accidental" | "spoilage" | "return" | "breakage"
export type DeductionStatus   = "proposed" | "acknowledged" | "disputed" | "approved" | "applied" | "cancelled"
export type IikoSyncStatus    = "none" | "pending" | "synced" | "error"
