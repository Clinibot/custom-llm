import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response } from "express";
import { RawData, WebSocket } from "ws";
import expressWs from "express-ws";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { LlmOpenAiClient } from "./llm-openai-client";
import {
    RetellRequest,
    RetellConfigEvent,
    RetellPingPongEvent,
    BotConfig,
} from "./types";

// ============================================================
// Server & DB Setup
// ============================================================

const app = express();
const wsInstance = expressWs(app);
const port = parseInt(process.env.PORT || "8080", 10);

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// Supabase client — Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are in .env
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================
// API Routes (Frontend)
// ============================================================

// Get current configuration
app.get("/api/config", async (_req: Request, res: Response) => {
    try {
        const { data, error } = await supabase
            .from("config")
            .select("*")
            .eq("id", "current")
            .single();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        // Return defaults if DB is not ready or empty
        res.json({
            system_prompt: `## Identity\nYou are a helpful AI assistant for Clinibot...`,
            greeting: "Hola, ¿en qué puedo ayudarte hoy?",
            model: "gpt-4o-mini"
        });
    }
});

// Save configuration
app.post("/api/config", async (req: Request, res: Response) => {
    try {
        const config: BotConfig = req.body;
        const { error } = await supabase
            .from("config")
            .upsert({ id: "current", ...config });

        if (error) throw error;
        res.json({ status: "ok" });
    } catch (err) {
        console.error("Error saving config:", err);
        res.status(500).json({ error: "Failed to save config" });
    }
});

app.get("/health", (_req: Request, res: Response) => {
    res.json({
        status: "ok",
        service: "Retell Custom LLM WebSocket Server",
        timestamp: new Date().toISOString(),
    });
});

// Serve index.html for all other routes (SPA behavior)
// Place this AFTER all specific API and assets routes
app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "../public", "index.html"));
});

// ============================================================
// WebSocket Route — Retell LLM Integration
// ============================================================

wsInstance.app.ws(
    "/llm-websocket/:call_id",
    async (ws: WebSocket, req: Request) => {
        const callId = req.params.call_id;
        console.log(`[${callId}] WebSocket connected`);

        // Create a new LLM client for this call
        const llmClient = new LlmOpenAiClient();

        // Initialize config from Supabase before starting
        await llmClient.initialize();

        // --- Send config event ---
        const configEvent: RetellConfigEvent = {
            response_type: "config",
            config: {
                auto_reconnect: true,
                call_details: false,
            },
        };
        ws.send(JSON.stringify(configEvent));

        // --- Send begin message (agent speaks first) ---
        llmClient.BeginMessage(ws);

        // --- Handle errors ---
        ws.on("error", (err: Error) => {
            console.error(`[${callId}] WebSocket error:`, err);
        });

        // --- Handle close ---
        ws.on("close", (code: number, reason: Buffer) => {
            console.log(
                `[${callId}] WebSocket closed — code: ${code}, reason: ${reason.toString()}`
            );
        });

        // --- Handle incoming messages from Retell ---
        ws.on("message", async (data: RawData, isBinary: boolean) => {
            if (isBinary) {
                console.error(`[${callId}] Received binary message, expected text.`);
                ws.close(1002, "Expected text message, got binary.");
                return;
            }

            try {
                const request: RetellRequest = JSON.parse(data.toString());

                // Handle ping_pong — echo back timestamp
                if (request.interaction_type === "ping_pong") {
                    const pong: RetellPingPongEvent = {
                        response_type: "ping_pong",
                        timestamp: request.timestamp!,
                    };
                    ws.send(JSON.stringify(pong));
                    return;
                }

                // Handle call_details — log and ignore
                if (request.interaction_type === "call_details") {
                    console.log(`[${callId}] Call details received:`, request.call);
                    return;
                }

                // Handle update_only, response_required, reminder_required
                llmClient.DraftResponse(request, ws);
            } catch (err) {
                console.error(`[${callId}] Error parsing message:`, err);
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
    console.log(`   Health check: http://localhost:${port}/`);
    console.log(
        `   WebSocket:    ws://localhost:${port}/llm-websocket/{call_id}`
    );
});
