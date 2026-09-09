import { Cause, Effect, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import type { Page } from "playwright-core"

const actionGroundingTimeout = "20 seconds"

export class BrowserActionError extends Schema.TaggedError<BrowserActionError>()("BrowserActionError", {
  message: Schema.String,
}) {}

export class BrowserAction extends Schema.Class<BrowserAction>("BrowserAction")({
  kind: Schema.Literals(["click", "type", "press", "select"]),
  selector: Schema.optionalKey(Schema.NonEmptyString),
  role: Schema.optionalKey(Schema.NonEmptyString),
  name: Schema.optionalKey(Schema.NonEmptyString),
  text: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.NonEmptyString),
  value: Schema.optionalKey(Schema.String),
}) {}

export interface GroundedBrowserAction {
  readonly action: BrowserAction
  readonly reasoningText?: string
}

export const describeBrowserAction = (action: BrowserAction) => {
  const parts: Array<string> = [action.kind]
  if (action.selector !== undefined) {
    parts.push(`selector=${action.selector}`)
  }
  if (action.role !== undefined) {
    parts.push(`role=${action.role}`)
  }
  if (action.name !== undefined) {
    parts.push(`name=${action.name}`)
  }
  if (action.text !== undefined) {
    parts.push(`text=${action.text}`)
  }
  if (action.key !== undefined) {
    parts.push(`key=${action.key}`)
  }
  if (action.value !== undefined) {
    parts.push(`value=${action.value}`)
  }
  return parts.join(" ")
}

export interface ActLocator {
  readonly click: (options?: { timeout?: number }) => Promise<unknown>
  readonly fill: (text: string, options?: { timeout?: number }) => Promise<unknown>
  readonly selectOption: (value: string, options?: { timeout?: number }) => Promise<unknown>
}

export interface ActLocatorSource {
  readonly first: () => ActLocator
}

export interface ActPage {
  readonly locator: (selector: string) => ActLocatorSource
  readonly getByRole: (role: string, options?: { name?: string }) => ActLocatorSource
  readonly keyboard: {
    readonly press: (key: string) => Promise<void>
  }
}

const hasTarget = (action: BrowserAction) => {
  const selector = action.selector?.trim()
  if (selector !== undefined && selector.length > 0) {
    return true
  }
  const role = action.role?.trim()
  return role !== undefined && role.length > 0
}

export const validateBrowserAction = (
  action: BrowserAction,
): Effect.Effect<BrowserAction, BrowserActionError> => {
  if (action.kind === "press") {
    if (action.key === undefined || action.key.trim().length === 0) {
      return Effect.fail(new BrowserActionError({
        message: "Keyboard actions need a key.",
      }))
    }
    return Effect.succeed(action)
  }
  if (!hasTarget(action)) {
    return Effect.fail(new BrowserActionError({
      message: `${action.kind} actions need a selector or role.`,
    }))
  }
  if (action.kind === "type" && action.text === undefined) {
    return Effect.fail(new BrowserActionError({
      message: "Type actions need text.",
    }))
  }
  if (action.kind === "select" && (action.value === undefined || action.value.trim().length === 0)) {
    return Effect.fail(new BrowserActionError({
      message: "Select actions need a value.",
    }))
  }
  return Effect.succeed(action)
}

export const asActPage = (page: Page): ActPage => ({
  locator: (selector) => page.locator(selector),
  getByRole: (role, options) =>
    page.getByRole(
      role as Parameters<Page["getByRole"]>[0],
      options?.name !== undefined ? { name: options.name } : {},
    ),
  keyboard: page.keyboard,
})

const locatorFor = (page: ActPage, action: BrowserAction): ActLocator => {
  const selector = action.selector?.trim()
  if (selector !== undefined && selector.length > 0) {
    return page.locator(selector).first()
  }
  const role = action.role?.trim()
  if (role !== undefined && role.length > 0) {
    const name = action.name?.trim()
    return page.getByRole(
      role,
      name !== undefined && name.length > 0 ? { name } : {},
    ).first()
  }
  throw new Error("Browser action is missing a selector or role.")
}

export const executeBrowserAction = async (
  page: ActPage,
  action: BrowserAction,
  timeoutMs: number,
): Promise<void> => {
  const timeout = { timeout: timeoutMs }
  if (action.kind === "press") {
    const key = action.key?.trim()
    if (key === undefined || key.length === 0) {
      throw new Error("Keyboard actions need a key.")
    }
    await page.keyboard.press(key)
    return
  }
  const locator = locatorFor(page, action)
  if (action.kind === "click") {
    await locator.click(timeout)
    return
  }
  if (action.kind === "type") {
    if (action.text === undefined) {
      throw new Error("Type actions need text.")
    }
    await locator.fill(action.text, timeout)
    return
  }
  const value = action.value?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error("Select actions need a value.")
  }
  await locator.selectOption(value, timeout)
}

const actPrompt = (instruction: string, snapshot: string) => [
  "You operate a browser by choosing one Playwright action.",
  "Pick the single next action that fulfills the instruction.",
  "Prefer a unique CSS selector from the snapshot when one is available.",
  "Otherwise set role and name from the accessibility tree (button, link, textbox, combobox).",
  "click: dismiss, follow, or activate a control.",
  "type: fill a field. Set text to the value to type.",
  "press: a keyboard key such as Enter, Escape, or Tab.",
  "select: choose an option on a select control. Set value to the option value or label.",
  `Instruction: ${instruction}`,
  "Page:",
  snapshot,
].join("\n")

export const groundBrowserAction = Effect.fn("groundBrowserAction")(function*(input: {
  readonly instruction: string
  readonly snapshot: string
}) {
  const response = yield* LanguageModel.generateObject({
    objectName: "browser_action",
    schema: BrowserAction,
    prompt: actPrompt(input.instruction, input.snapshot),
  }).pipe(
    Effect.timeout(actionGroundingTimeout),
    Effect.catchIf(
      Cause.isTimeoutError,
      () =>
        new BrowserActionError({
          message: "Timed out deciding how to act on the page.",
        }),
    ),
  )
  const action = yield* validateBrowserAction(response.value)
  return {
    action,
    ...(response.reasoningText !== undefined ? { reasoningText: response.reasoningText } : {}),
  }
})
