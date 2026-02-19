import dotenv from "dotenv";
dotenv.config();

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

app.use(express.json());

// Basic Auth Configuration
const auth = basicAuth({
    users: { 'sonia@sonia.com': 'sonia@sonia.com' },
    challenge: true,
    realm: 'Clinibot Builder'
});

// Protect UI and API routes, but allow /health and websockets
app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/health" || req.path.startsWith("/llm-websocket")) {
        return next();
    }
    return auth(req, res, next);
});

app.use(express.static(path.join(__dirname, "../public")));

// Supabase client — Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are in .env
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================
// API Routes (Frontend)
// ============================================================

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

// Save/Update agent configuration
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
app.get("/health", (_req: Request, res: Response) => {
    res.json({
        status: "ok",
        service: "Retell Custom LLM WebSocket Server",
        timestamp: new Date().toISOString(),
    });
});

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

// Serve index.html for all other routes (SPA behavior)
app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "../public", "index.html"));
});

// ============================================================
// WebSocket Route — Retell LLM Integration
// ============================================================

wsInstance.app.ws(
    "/llm-websocket/:agent_id/:call_id",
    async (ws: WebSocket, req: Request) => {
        const { agent_id, call_id } = req.params;
        console.log(`[${call_id}] Agent ${agent_id} connected`);

        const llmClient = new LlmOpenAiClient();
        await llmClient.initialize(agent_id as string);

        const configEvent: RetellConfigEvent = {
            response_type: "config",
            config: {
                auto_reconnect: true,
                call_details: false,
            },
        };
        ws.send(JSON.stringify(configEvent));

        llmClient.BeginMessage(ws);

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
                console.error(`[${call_id}] Received binary message, expected text.`);
                ws.close(1002, "Expected text message, got binary.");
                return;
            }

            try {
                const request: RetellRequest = JSON.parse(data.toString());

                if (request.interaction_type === "ping_pong") {
                    const pong: RetellPingPongEvent = {
                        response_type: "ping_pong",
                        timestamp: request.timestamp!,
                    };
                    ws.send(JSON.stringify(pong));
                    return;
                }

                if (request.interaction_type === "call_details") {
                    console.log(`[${call_id}] Call details received:`, request.call);
                    return;
                }

                llmClient.DraftResponse(request, ws);
            } catch (err) {
                console.error(`[${call_id}] Error parsing message:`, err);
                ws.close(1002, "Cannot parse incoming message.");
            }
        });
    }
);

// ============================================================
// Start Server
// ============================================================

app.listen(port, () => {
    console.log(`🚀 Retell Custom LLM server listening on port ${port}`);
});
