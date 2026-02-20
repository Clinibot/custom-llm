import dotenv from "dotenv";
dotenv.config(); // Updated: 2026-02-19 17:56

import express, { Request, Response, NextFunction } from "express";
import { RawData, WebSocket } from "ws";
import expressWs from "express-ws";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import basicAuth from "express-basic-auth";
import { LlmOpenAiClient } from "./llm-openai-client";
import {
    RetellRequest,
    RetellConfigEvent,
    RetellPingPongEvent,
    Agent,
    Profile
} from "./types";

// ============================================================
// Server & DB Setup
// ============================================================

const app = express();
const wsInstance = expressWs(app);
const port = parseInt(process.env.PORT || "8080", 10);

// ============================================================
// Global Logging Middleware
// ============================================================
app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ============================================================
// WebSocket Route — Retell LLM Integration (Move to TOP)
// ============================================================
wsInstance.app.ws(
    "/llm-websocket/:call_id",
    async (ws: WebSocket, req: Request) => {
        const { call_id } = req.params;
        const agent_id = req.query.agent_id as string;

        if (!agent_id) {
            console.error(`[${call_id}] Connection refused: Missing agent_id in query params.`);
            ws.close(1008, "Missing agent_id");
            return;
        }

        console.log(`[${call_id}] Connection Attempt for Agent ${agent_id}`);

        const llmClient = new LlmOpenAiClient();
        await llmClient.initialize(agent_id);

        const configEvent: RetellConfigEvent = {
            response_type: "config",
            config: {
                auto_reconnect: true,
                call_details: false,
            },
        };
        ws.send(JSON.stringify(configEvent));
        console.log(`[${call_id}] ✅ Config sent. Protocol: ${JSON.stringify(configEvent.config)}`);

        // Force Greeting - Zero delay from server.ts to ensure protocol compliance
        const greetingContent = llmClient.greeting || "Hola, ¿cómo puedo ayudarte?";
        console.log(`[${call_id}] 🚀 Sending Greeting: "${greetingContent}"`);
        ws.send(JSON.stringify({
            response_type: "response",
            response_id: 0,
            content: greetingContent,
            content_complete: true,
            end_call: false,
        }));

        ws.on("error", (err: Error) => {
            console.error(`[${call_id}] WebSocket error:`, err);
        });

        ws.on("close", (code: number, reason: Buffer) => {
            console.log(
                `[${call_id}] WebSocket closed — code: ${code}, reason: ${reason.toString()}`
            );
        });

        ws.on("message", async (data: RawData, isBinary: boolean) => {
            if (isBinary) {
                ws.close(1002, "Text only.");
                return;
            }

            try {
                const request: RetellRequest = JSON.parse(data.toString());
                await llmClient.DraftResponse(request, ws);
            } catch (err) {
                console.error(`[${call_id}] WS Error:`, err);
            }
        });
    }
);

// Fallback Route for duplicated call_id /llm-websocket/call_xxx/call_xxx
wsInstance.app.ws(
    "/llm-websocket/:call_id/:call_id_duplicate",
    async (ws: WebSocket, req: Request) => {
        const { call_id } = req.params;
        const agent_id = req.query.agent_id as string;
        console.log(`[${call_id}] ⚠️ Duplicated URL detected, handling gracefully. Agent: ${agent_id}`);

        if (!agent_id) {
            ws.close(1008, "Missing agent_id");
            return;
        }

        const llmClient = new LlmOpenAiClient();
        await llmClient.initialize(agent_id);

        const configEvent: RetellConfigEvent = {
            response_type: "config",
            config: { auto_reconnect: true, call_details: false },
        };
        ws.send(JSON.stringify(configEvent));

        // Greeting
        const greetingContent = llmClient.greeting || "Hola, ¿cómo puedo ayudarte?";
        console.log(`[${call_id}] 🚀 Sending Greeting (Fallback): "${greetingContent}"`);
        ws.send(JSON.stringify({
            response_type: "response",
            response_id: 0,
            content: greetingContent,
            content_complete: true,
            end_call: false,
        }));

        ws.on("message", async (data: RawData) => {
            try {
                const request: RetellRequest = JSON.parse(data.toString());
                await llmClient.DraftResponse(request, ws);
            } catch (err) {
                console.error(`[${call_id}] Parse Error (Fallback):`, err);
            }
        });
    }
);

app.use(express.json());

// Health & Version
app.get("/health", (_req: Request, res: Response) => {
    res.json({
        status: "ok",
        version: "v6.0.0",
        service: "IA Al Teléfono - Custom LLM Multi-User",
        timestamp: new Date().toISOString(),
    });
});

// Middleware to get current user from header
// In this simplified version, we'll trust the X-User-Id header
app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).userId = req.headers['x-user-id'];
    next();
});

// Register or Login (returns Profile)
app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
        const { name, email } = req.body;
        if (!name || !email) return res.status(400).json({ error: "Nombre y Email son requeridos" });

        // Check if user exists
        let { data: profile, error } = await supabase
            .from("profiles")
            .select("*")
            .eq("email", email)
            .single();

        if (error && error.code !== 'PGRST116') throw error;

        if (!profile) {
            // Create user
            console.log(`[AUTH] Creating new user: ${email}`);
            const { data, error: insertError } = await supabase
                .from("profiles")
                .insert([{ name, email }])
                .select()
                .single();
            if (insertError) throw insertError;
            profile = data;
        }

        res.json(profile);
    } catch (err) {
        console.error("Error in registration:", err);
        res.status(500).json({ error: "Error al registrar usuario" });
    }
});

app.use(express.static(path.join(__dirname, "../public")));

// Supabase client — Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are in .env
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// List agents (Filtered by User)
app.get("/api/agents", async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        if (!userId) return res.json([]); // Return empty list if no user

        const { data, error } = await supabase
            .from("agents")
            .select("id, name")
            .eq("user_id", userId)
            .order("created_at", { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Failed to list agents" });
    }
});

// Get agent (Filtered by User)
app.get("/api/agents/:id", async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const userId = (req as any).userId;

        const { data, error } = await supabase
            .from("agents")
            .select("*")
            .eq("id", id)
            .eq("user_id", userId)
            .single();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(404).json({ error: "Agent not found" });
    }
});

// Save/Update agent (With User ID)
app.post("/api/agents", async (req: Request, res: Response) => {
    try {
        const agent: Agent = req.body;
        const userId = (req as any).userId;
        if (!userId) return res.status(401).json({ error: "Login required" });

        const { data, error } = await supabase
            .from("agents")
            .upsert({
                ...agent,
                id: agent.id || undefined,
                user_id: userId
            })
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error("Error saving agent:", err);
        res.status(500).json({ error: "Failed to save agent" });
    }
});

// Delete agent
app.delete("/api/agents/:id", async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const userId = (req as any).userId;

        const { error } = await supabase
            .from("agents")
            .delete()
            .eq("id", id)
            .eq("user_id", userId);

        if (error) throw error;
        res.json({ status: "ok" });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete agent" });
    }
});


// Serve UI for root and fallback
const indexPath = path.join(__dirname, "../public/index.html");

app.get("/", (_req: Request, res: Response) => {
    res.sendFile(indexPath);
});

app.get("*", (req: Request, res: Response) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
    res.sendFile(indexPath);
});

// ============================================================
// WebSocket Route — Retell LLM Integration
// ============================================================


// ============================================================
// Start Server
// ============================================================

app.listen(port, "0.0.0.0", () => {
    console.log(`🚀 IA Al Teléfono server listening on port ${port}`);
    console.log(`📡 Node Version: ${process.version}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'production'}`);
});
