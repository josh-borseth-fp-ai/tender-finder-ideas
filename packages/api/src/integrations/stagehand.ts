import { browserbase, Stagehand } from "@browserbasehq/stagehand"
import type { ClientLLM } from "@browserbasehq/stagehand"
import type { OpenRouter as OpenRouterSdk } from "@openrouter/sdk"
import type { ChatContentItems, ChatMessages, ChatResult } from "@openrouter/sdk/models"
import { Context, Effect, Layer, Redacted } from "effect"
import { BrowserbaseClient } from "./browserbase.ts"
import { IntegrationConfig } from "./config.ts"
import { StagehandOpenError } from "./errors.ts"
import { OpenRouter } from "./open-router.ts"

const sessionTimeoutSeconds = 3600

export interface StagehandSessionHandle {
  readonly browser: Stagehand["browser"]
  readonly stagehand: Stagehand
  readonly sessionId: string
  readonly liveViewUrl: string
  readonly close: () => Effect.Effect<void>
}

type GenerateParams = Parameters<ClientLLM["generate"]>[0]
type GenerateResult = Awaited<ReturnType<ClientLLM["generate"]>>
type GenerateContent = GenerateParams["messages"][number]["content"]

const contentBlocks = (content: GenerateContent) => Array.isArray(content) ? content : [content]

const toOpenRouterContent = (content: GenerateContent): Array<ChatContentItems> =>
  contentBlocks(content).map((block): ChatContentItems => {
    if (block.type === "text") {
      return { type: "text", text: block.text }
    }
    if (block.type === "image") {
      return {
        type: "image_url",
        imageUrl: {
          url: `data:${block.mimeType};base64,${block.data}`,
          detail: "auto",
        },
      }
    }
    if (block.type === "tool_use") {
      return { type: "text", text: `[tool_use ${block.name}] ${JSON.stringify(block.input)}` }
    }
    return { type: "text", text: JSON.stringify(block) }
  })

const toOpenRouterMessages = (params: GenerateParams): Array<ChatMessages> => {
  const messages: Array<ChatMessages> = []
  if (params.systemPrompt !== undefined) {
    messages.push({ role: "system", content: params.systemPrompt })
  }
  for (const message of params.messages) {
    const content = toOpenRouterContent(message.content)
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content })
    } else {
      messages.push({ role: "user", content })
    }
  }
  return messages
}

const assistantText = (completion: ChatResult): string => {
  const content = completion.choices[0]?.message.content
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : [])
      .join("")
  }
  return ""
}

const makeOpenRouterGenerate = (client: OpenRouterSdk, model: string): ClientLLM["generate"] =>
  async (params) => {
    if (params.responseFormat?.type !== "json_schema") {
      throw new TypeError("Stagehand only issues structured generations")
    }

    const completion = await client.chat.send({
      chatRequest: {
        model,
        messages: toOpenRouterMessages(params),
        stream: false,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.stopSequences !== undefined ? { stop: params.stopSequences } : {}),
        responseFormat: {
          type: "json_schema",
          jsonSchema: {
            name: params.responseFormat.name,
            schema: params.responseFormat.schema as { [k: string]: unknown },
            strict: true,
            ...(params.responseFormat.description !== undefined
              ? { description: params.responseFormat.description }
              : {}),
          },
        },
      },
    })

    if (completion instanceof ReadableStream) {
      throw new TypeError("Expected a non-streaming OpenRouter response")
    }

    const text = assistantText(completion)
    if (text.length === 0) {
      throw new TypeError("OpenRouter returned empty content")
    }

    let structuredContent: unknown
    try {
      structuredContent = JSON.parse(text)
    } catch (cause) {
      throw new TypeError("OpenRouter returned invalid JSON", { cause })
    }

    const usage = completion.usage === undefined ? undefined : {
      inputTokens: completion.usage.promptTokens,
      outputTokens: completion.usage.completionTokens,
      totalTokens: completion.usage.totalTokens,
      ...(completion.usage.completionTokensDetails?.reasoningTokens != null
        ? { reasoningTokens: completion.usage.completionTokensDetails.reasoningTokens }
        : {}),
      ...(completion.usage.promptTokensDetails?.cachedTokens !== undefined
        ? { cachedInputTokens: completion.usage.promptTokensDetails.cachedTokens }
        : {}),
    }

    return {
      role: "assistant",
      content: { type: "text", text },
      outputFormat: "json_schema",
      structuredContent,
      ...(usage !== undefined ? { usage } : {}),
    } as GenerateResult
  }

export class StagehandSession extends Context.Service<
  StagehandSession,
  {
    readonly open: () => Effect.Effect<StagehandSessionHandle, StagehandOpenError>
  }
>()("@app/StagehandSession") {
  static readonly layer = Layer.effect(
    StagehandSession,
    Effect.gen(function*() {
      const config = yield* IntegrationConfig
      const openRouter = yield* OpenRouter
      const browserbaseClient = yield* BrowserbaseClient
      const generate = makeOpenRouterGenerate(openRouter.client, config.openRouterModel)
      const apiKey = Redacted.value(config.browserbaseApiKey)
      const projectId = config.browserbaseProjectId

      const open = Effect.fn("StagehandSession.open")(function*() {
        const browser = yield* Effect.tryPromise({
          try: () =>
            browserbase.launch({
              apiKey,
              projectId,
              keepAlive: true,
              api_timeout: sessionTimeoutSeconds,
              browserSettings: {
                solveCaptchas: false,
              },
            }),
          catch: (cause) => new StagehandOpenError({ cause }),
        })

        const sessionId = browser.sessionId
        if (sessionId === undefined) {
          yield* Effect.promise(() => browser.close())
          return yield* new StagehandOpenError({ cause: "Browserbase session id missing" })
        }

        const liveViewUrl = yield* browserbaseClient.liveViewUrl(sessionId).pipe(
          Effect.mapError((cause) => new StagehandOpenError({ cause })),
          Effect.tapError(() => Effect.promise(() => browser.close())),
        )

        const stagehand = yield* Effect.tryPromise({
          try: () =>
            Stagehand.create({
              browser,
              model: { generate },
            }),
          catch: (cause) => new StagehandOpenError({ cause }),
        }).pipe(
          Effect.tapError(() => Effect.promise(() => browser.close())),
        )

        const close = Effect.fn("StagehandSession.close")(function*() {
          yield* Effect.promise(() => stagehand.close())
          yield* Effect.promise(() => browser.close())
          yield* browserbaseClient.release(sessionId)
        })

        return { browser, stagehand, sessionId, liveViewUrl, close }
      })

      return { open }
    }),
  )
}
