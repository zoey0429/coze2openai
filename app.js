import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const app = express();
app.use(bodyParser.json());

const coze_api_base = process.env.COZE_API_BASE || "api.coze.com";
const default_bot_id = process.env.BOT_ID || "";
const botConfig = process.env.BOT_CONFIG ? JSON.parse(process.env.BOT_CONFIG) : {};
const openai_api_key = process.env.OPENAI_API_KEY || "";

var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization",
  "Access-Control-Max-Age": "86400",
};

app.use((req, res, next) => {
  res.set(corsHeaders);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  console.log('Request Method:', req.method); 
  console.log('Request Path:', req.path);
  console.log('Authorization Header:', req.headers.authorization ? 'Present' : 'Missing');
  next();
});

// 统一的认证中间件
function authenticateRequest(req, res, next) {
  console.log('=== Authentication Check ===');
  console.log('OPENAI_API_KEY configured:', openai_api_key ? 'Yes' : 'No');
  
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  console.log('Auth header received:', authHeader ? 'Yes' : 'No');
  
  if (!authHeader) {
    console.log('❌ No authorization header provided');
    return res.status(401).json({
      error: {
        message: "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY)",
        type: "invalid_request_error"
      }
    });
  }

  if (!authHeader.startsWith('Bearer ')) {
    console.log('❌ Invalid authorization header format');
    return res.status(401).json({
      error: {
        message: "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY)",
        type: "invalid_request_error"
      }
    });
  }

  const providedKey = authHeader.split(' ')[1];
  console.log('Provided key:', providedKey ? 'Present' : 'Missing');
  console.log('Expected key:', openai_api_key ? 'Present' : 'Missing');

  if (!openai_api_key) {
    console.log('❌ OPENAI_API_KEY not configured in environment');
    return res.status(500).json({
      error: {
        message: "Server configuration error: API key not configured",
        type: "server_error"
      }
    });
  }

  if (providedKey !== openai_api_key) {
    console.log('❌ API key mismatch');
    return res.status(401).json({
      error: {
        message: "Incorrect API key provided",
        type: "invalid_request_error"
      }
    });
  }

  console.log('✅ Authentication successful');
  next();
}

// 调试端点
app.get("/debug", (req, res) => {
  console.log('=== Debug Endpoint Called ===');
  res.json({
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    hasBotId: !!process.env.BOT_ID,
    hasCozeBase: !!process.env.COZE_API_BASE,
    hasBotConfig: !!process.env.BOT_CONFIG,
    nodeEnv: process.env.NODE_ENV,
    cozeApiBase: coze_api_base,
    botConfigKeys: Object.keys(botConfig),
    timestamp: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>COZE2OPENAI</title>
      </head>
      <body>
        <h1>Coze2OpenAI</h1>
        <p>Congratulations! Your project has been successfully deployed.</p>
        <p><a href="/debug">Debug Info</a></p>
      </body>
    </html>
  `);
});

// 修改后的 /v1/models 端点
app.get("/v1/models", authenticateRequest, (req, res) => {
  console.log('=== /v1/models endpoint called ===');
  console.log('Bot config:', Object.keys(botConfig));
  
  const models = {
    object: "list",
    data: []
  };

  // 如果配置了多个Bot，添加到模型列表
  if (Object.keys(botConfig).length > 0) {
    Object.keys(botConfig).forEach(modelName => {
      console.log('Adding model:', modelName);
      models.data.push({
        id: modelName,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "coze",
        permission: [],
        root: modelName,
        parent: null
      });
    });
  } else {
    // 如果没有配置多Bot，返回默认模型
    console.log('Using default model: gpt-4');
    models.data.push({
      id: "gpt-4",
      object: "model", 
      created: Math.floor(Date.now() / 1000),
      owned_by: "coze",
      permission: [],
      root: "gpt-4",
      parent: null
    });
  }

  console.log('Returning models:', models.data.map(m => m.id));
  res.json(models);
});

// 修改后的 /v1/chat/completions 端点
app.post("/v1/chat/completions", authenticateRequest, async (req, res) => {
  console.log('=== /v1/chat/completions endpoint called ===');
  
  try {
    const data = req.body;
    const messages = data.messages;
    const model = data.model;
    const user = data.user !== undefined ? data.user : "apiuser";
    
    console.log('Model requested:', model);
    console.log('Messages count:', messages.length);
    
    const chatHistory = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const message = messages[i];
      const role = message.role;
      const content = message.content;
      
      chatHistory.push({
        role: role,
        content: content,
        content_type: "text"
      });
    }

    const lastMessage = messages[messages.length - 1];
    const queryString = lastMessage.content;
    const stream = data.stream !== undefined ? data.stream : false;
    let requestBody;
    const bot_id = model && botConfig[model] ? botConfig[model] : default_bot_id;
    
    console.log('Using bot_id:', bot_id);
    console.log('Coze API base:', coze_api_base);

    requestBody = {
      query: queryString,
      stream: stream,
      conversation_id: "",
      user: user,
      bot_id: bot_id,
      chat_history: chatHistory
    };
    
    const coze_api_url = `https://${coze_api_base}/open_api/v2/chat`;
    console.log('Calling Coze API:', coze_api_url);
    
    // 使用客户端提供的token调用Coze API
    const authHeader = req.headers["authorization"] || req.headers["Authorization"];
    const clientToken = authHeader.split(" ")[1];
    
    const resp = await fetch(coze_api_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${clientToken}`,
      },
      body: JSON.stringify(requestBody),
    });
    
    console.log('Coze API response status:', resp.status);
    
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      const stream = resp.body;
      let buffer = "";

      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        let lines = buffer.split("\n");

        for (let i = 0; i < lines.length - 1; i++) {
          let line = lines[i].trim();

          if (!line.startsWith("data:")) continue;
          line = line.slice(5).trim();
          let chunkObj;
          try {
            if (line.startsWith("{")) {
              chunkObj = JSON.parse(line);
            } else {
              continue;
            }
          } catch (error) {
            console.error("Error parsing chunk:", error);
            continue;
          }
          if (chunkObj.event === "message") {
            if (
              chunkObj.message.role === "assistant" &&
              chunkObj.message.type === "answer"
            ) {
              let chunkContent = chunkObj.message.content;

              if (chunkContent !== "") {
                const chunkId = `chatcmpl-${Date.now()}`;
                const chunkCreated = Math.floor(Date.now() / 1000);
                res.write(
                  "data: " +
                    JSON.stringify({
                      id: chunkId,
                      object: "chat.completion.chunk",
                      created: chunkCreated,
                      model: data.model,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            content: chunkContent,
                          },
                          finish_reason: null,
                        },
                      ],
                    }) +
                    "\n\n"
                );
              }
            }
          } else if (chunkObj.event === "done") {
            const chunkId = `chatcmpl-${Date.now()}`;
            const chunkCreated = Math.floor(Date.now() / 1000);
            res.write(
              "data: " +
                JSON.stringify({
                  id: chunkId,
                  object: "chat.completion.chunk",
                  created: chunkCreated,
                  model: data.model,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: "stop",
                    },
                  ],
                }) +
                "\n\n"
            );
            res.write("data: [DONE]\n\n");
            res.end();
          } else if (chunkObj.event === "ping") {
          } else if (chunkObj.event === "error") {
            let errorMsg = chunkObj.code + " " + chunkObj.message;

            if(chunkObj.error_information) {
              errorMsg = chunkObj.error_information.err_msg;
            }

            console.error('Coze API Error: ', errorMsg);

            res.write(
                    `data: ${JSON.stringify({ error: {
                        error: "Unexpected response from Coze API.",
                        message: errorMsg
                      }
                    })}\n\n`
                );
            res.write("data: [DONE]\n\n");
            res.end();
          }
        }

        buffer = lines[lines.length - 1];
      });
    } else {
      resp
        .json()
        .then((data) => {
          console.log('Coze API response:', data);
          if (data.code === 0 && data.msg === "success") {
            const messages = data.messages;
            const answerMessage = messages.find(
              (message) =>
                message.role === "assistant" && message.type === "answer"
            );

            if (answerMessage) {
              const result = answerMessage.content.trim();
              const usageData = {
                prompt_tokens: 100,
                completion_tokens: 10,
                total_tokens: 110,
              };
              const chunkId = `chatcmpl-${Date.now()}`;
              const chunkCreated = Math.floor(Date.now() / 1000);

              const formattedResponse = {
                id: chunkId,
                object: "chat.completion",
                created: chunkCreated,
                model: req.body.model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: result,
                    },
                    logprobs: null,
                    finish_reason: "stop",
                  },
                ],
                usage: usageData,
                system_fingerprint: "fp_2f57f81c11",
              };
              const jsonResponse = JSON.stringify(formattedResponse, null, 2);
              res.set("Content-Type", "application/json");
              res.send(jsonResponse);
            } else {
              res.status(500).json({ error: "No answer message found." });
            }
          } else {
            console.error("Coze API Error:", data.msg);
            res
              .status(500)
              .json({ error: {
                    error: "Unexpected response from Coze API.",
                    message: data.msg
                }
              });
          }
        })
        .catch((error) => {
          console.error("Error parsing JSON:", error);
          res.status(500).json({ error: "Error parsing JSON response." });
        });
    }
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const server = app.listen(process.env.PORT || 3000, function () {
  let port = server.address().port
  console.log('Ready! Listening all IP, port: %s. Example: at http://localhost:%s', port, port)
  console.log('Environment check:');
  console.log('- OPENAI_API_KEY:', openai_api_key ? 'Configured' : 'Missing');
  console.log('- BOT_ID:', default_bot_id ? 'Configured' : 'Missing');
  console.log('- COZE_API_BASE:', coze_api_base);
  console.log('- BOT_CONFIG keys:', Object.keys(botConfig));
});
