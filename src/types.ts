/**
 * Retell AI Custom LLM WebSocket Protocol Types
 * Based on: https://docs.retellai.com/api-references/llm-websocket
 */

// ============================================================
// Shared Types
// ============================================================

export interface Utterance {
    role: "agent" | "user";
    content: string;
}

// ============================================================
// Retell -> Your Server (Incoming Events)
// ============================================================

export interface RetellRequest {
    /** Unique ID for matching response to request */
    response_id?: number;

    /** The interaction type determines what your server should do */
    interaction_type:
    | "call_details"
    | "ping_pong"
    | "update_only"
    | "response_required"
    | "reminder_required";

    /** Transcript of the conversation so far */
    transcript?: Utterance[];

    /** Timestamp for ping_pong events */
    timestamp?: number;

    /** Full transcript including tool calls (if enabled in config) */
    transcript_with_tool_calls?: any[];

    /** Turn-taking information */
    turntaking?: "agent_turn" | "user_turn";

    /** Call details (sent when call_details is enabled in config) */
    call?: Record<string, any>;
}

// ============================================================
// Your Server -> Retell (Outgoing Events)
// ============================================================

/** Config event — sent once upon WebSocket connection */
export interface RetellConfigEvent {
    response_type: "config";
    config: {
        /** Enable auto-reconnect if connection drops */
        auto_reconnect?: boolean;
        /** Request call details to be sent */
        call_details?: boolean;
        /** Enable transcript_with_tool_calls in events */
        transcript_with_tool_calls?: boolean;
    };
}

/** Response event — sent in reply to response_required / reminder_required */
export interface RetellResponseEvent {
    response_type: "response";
    /** Must match the response_id from the request */
    response_id: number;
    /** The text content to speak */
    content: string;
    /** True when streaming is complete for this response */
    content_complete: boolean;
    /** Set to true to end the call */
    end_call: boolean;
}

/** Ping pong event — echo back timestamp */
export interface RetellPingPongEvent {
    response_type: "ping_pong";
    timestamp: number;
}

export type RetellEvent =
    | RetellConfigEvent
    | RetellResponseEvent
    | RetellPingPongEvent;

export interface Agent {
    id?: string;
    name: string;
    system_prompt: string;
    greeting: string;
    model: string;
    temperature: number;
    max_tokens: number;
    reminder_text: string;
    // New fields
    knowledge_base?: string;
    webhook_url?: string;
    hangup_phrases?: string; // Comma separated
    extraction_fields?: string; // Comma separated
    language?: string;
    // API Keys for Multi-user support
    openai_api_key?: string;
    retell_api_key?: string;
    // Advanced Call Settings
    end_call_silence_ms?: number;
    max_call_duration_ms?: number;
    ring_duration_s?: number;
}
