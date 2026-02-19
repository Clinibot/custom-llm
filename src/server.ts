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

// Basic Auth Configuration
const auth = basicAuth({
    users: { 'sonia@sonia.com': 'sonia@sonia.com' },
    challenge: true,
    realm: 'Clinibot Builder'
});

// ============================================================
// API Routes & Health
// ============================================================

app.get("/health", (_req: Request, res: Response) => {
    res.json({
        status: "ok",
        version: "v2.2.0",
        service: "IA Al Teléfono - Custom LLM Server",
        timestamp: new Date().toISOString(),
    });
});

// Protect all other routes
app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/llm-websocket")) {
        return next();
    }
    return auth(req, res, next);
});

app.use(express.static(path.join(__dirname, "../public")));

// Supabase client — Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are in .env
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// List all agents
app.get("/api/agents", async (_req: Request, res: Response) => {
    try {
        const { data, error } = await supabase
            .from("agents")
            .select("id, name")
            .order("created_at", { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Failed to list agents" });
    }
});

// Get specific agent configuration
app.get("/api/agents/:id", async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from("agents")
            .select("*")
            .eq("id", id)
            .single();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(404).json({ error: "Agent not found" });
    }
});

// Save/Update agent
app.post("/api/agents", async (req: Request, res: Response) => {
    try {
        const agent: Agent = req.body;
        const { data, error } = await supabase
            .from("agents")
            .upsert({
                ...agent,
                id: agent.id || undefined
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
        const { error } = await supabase
            .from("agents")
            .delete()
            .eq("id", id);

        if (error) throw error;
        res.json({ status: "ok" });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete agent" });
    }
});

// Retell Webhook Receiver (Statistics)
app.post("/api/webhook/retell", async (req: Request, res: Response) => {
    try {
        const { event, call } = req.body;

        // 1. Only process 'call_analyzed'
        if (event !== "call_analyzed") {
            return res.status(200).json({ status: "ignored", event });
        }

        const agentId = call.agent_id;
        console.log(`[Webhook] Received call_analyzed for agent: ${agentId}`);

        // 2. Fetch agent's webhook configuration
        const { data: agent, error } = await supabase
            .from("agents")
            .select("webhook_url")
            .eq("id", agentId)
            .single();

        if (error || !agent?.webhook_url) {
            console.log(`[Webhook] No webhook_url configured for agent ${agentId}`);
            return res.status(200).json({ status: "no_webhook_configured" });
        }

        // 3. Forward to Make/n8n
        console.log(`[Webhook] Forwarding to: ${agent.webhook_url}`);
        fetch(agent.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });

        res.json({ status: "forwarded" });
    } catch (err) {
        console.error("[Webhook Error]:", err);
        res.status(500).json({ error: "Internal server error" });
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
