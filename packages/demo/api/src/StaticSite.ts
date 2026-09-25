/**
 * Serves the built chat UI (`apps/web/dist`) and the docs
 * (`apps/docs/.vitepress/dist`, under `/docs`).
 *
 * `pnpm run build` writes both. `GET /` answers with `index.html`,
 * `GET /assets/*` with the bundle, and any other page path with `index.html`
 * (the app routes on the client). `/docs/guide/specialists` answers with
 * `guide/specialists.html` (VitePress's clean URLs). `/health` and `/rpc` keep
 * their own handlers.
 *
 * @since 0.1.0
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { existsSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import * as path from "node:path"

const apiPaths = ["/health", "/rpc"]

const isApiPath = (pathname: string): boolean =>
  apiPaths.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".map", "application/json"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"]
])

/** A missing asset is a 404, not the app. */
const isAsset = (pathname: string): boolean => {
  const ext = path.extname(pathname).toLowerCase()

  return ext !== ".html" && contentTypes.has(ext)
}

const safeFileUnderRoot = (root: string, candidate: string): string | undefined => {
  if (!existsSync(candidate)) return undefined

  const realRoot = realpathSync(root)
  const realFile = realpathSync(candidate)

  return realFile === realRoot || realFile.startsWith(`${realRoot}${path.sep}`) ? realFile : undefined
}

const siteRoot = (override: Option.Option<string>): string | undefined => {
  const candidates = [
    ...Option.toArray(override),
    path.resolve(import.meta.dirname, "../../../../apps/web/dist"),
    path.resolve(process.cwd(), "apps/web/dist"),
    path.resolve(process.cwd(), "../../../apps/web/dist")
  ]

  return candidates.find((root) => existsSync(path.join(root, "index.html")))
}

const docsPrefix = "/docs"

const docsRoot = (): string | undefined => {
  const candidates = [
    path.resolve(import.meta.dirname, "../../../../apps/docs/.vitepress/dist"),
    path.resolve(process.cwd(), "apps/docs/.vitepress/dist"),
    path.resolve(process.cwd(), "../../../apps/docs/.vitepress/dist")
  ]

  return candidates.find((root) => existsSync(path.join(root, "index.html")))
}

const requestPath = (requestUrl: string): string | undefined =>
  Option.getOrUndefined(
    Option.liftThrowable(() => decodeURIComponent(new URL(requestUrl, "http://localhost").pathname))()
  )

const isDocsPath = (pathname: string): boolean => pathname === docsPrefix || pathname.startsWith(`${docsPrefix}/`)

/** A docs page: the file, `<page>.html`, or `<page>/index.html`; the docs' 404 page otherwise. */
const docsFile = (root: string, pathname: string): { readonly file: string; readonly status: number } | undefined => {
  const relative = pathname.slice(docsPrefix.length).replace(/^\/+/, "")

  if (relative.includes("\0")) return undefined

  const rootResolved = path.resolve(root)

  const candidates =
    relative === "" ? ["index.html"] : [relative, `${relative}.html`, path.join(relative, "index.html")]

  for (const candidate of candidates) {
    const file = safeFileUnderRoot(rootResolved, path.resolve(rootResolved, candidate))

    if (file !== undefined && !file.endsWith(path.sep) && path.extname(file) !== "") return { file, status: 200 }
  }

  const notFound = safeFileUnderRoot(rootResolved, path.join(rootResolved, "404.html"))

  return notFound === undefined ? undefined : { file: notFound, status: 404 }
}

/** Maps a request URL onto a file inside `root`, or undefined when it isn't part of the site. */
const siteFile = (root: string, requestUrl: string): string | undefined => {
  const pathname = requestPath(requestUrl)

  if (pathname === undefined || isApiPath(pathname)) return undefined

  const relative = pathname === "/" ? "index.html" : pathname.slice(1)

  if (relative.length === 0 || relative.includes("\0")) return undefined

  const rootResolved = path.resolve(root)
  const resolved = path.resolve(rootResolved, relative)

  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) return undefined

  if (existsSync(resolved)) return safeFileUnderRoot(rootResolved, resolved)

  return isAsset(pathname) ? undefined : safeFileUnderRoot(rootResolved, path.join(rootResolved, "index.html"))
}

/** The file for a request: a docs page under `/docs`, or the chat UI. */
const fileFor = (
  override: Option.Option<string>,
  requestUrl: string
): { readonly file: string; readonly status: number } | undefined => {
  const pathname = requestPath(requestUrl)

  if (pathname !== undefined && isDocsPath(pathname)) {
    const root = docsRoot()

    return root === undefined ? undefined : docsFile(root, pathname)
  }

  const root = siteRoot(override)
  const file = root === undefined ? undefined : siteFile(root, requestUrl)

  return file === undefined ? undefined : { file, status: 200 }
}

const siteResponse = Effect.fn(function* (override: Option.Option<string>, requestUrl: string) {
  const found = fileFor(override, requestUrl)

  if (found === undefined) return undefined

  const bytes = yield* Effect.tryPromise(() => readFile(found.file)).pipe(Effect.option)

  if (Option.isNone(bytes)) return undefined

  const page = path.extname(found.file) === ".html"

  return HttpServerResponse.uint8Array(bytes.value, {
    status: found.status,
    contentType: contentTypes.get(path.extname(found.file)) ?? "application/octet-stream",
    headers: { "cache-control": page ? "no-cache" : "public, max-age=3600" }
  })
})

/**
 * Layer that serves the site for `GET` and `HEAD` requests it has a file for,
 * and passes everything else on. `ACME_WEB_DIST` overrides where the build
 * is.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const override = yield* Config.option(Config.NonEmptyString("ACME_WEB_DIST"))

    // An arrow, not Effect.fn: the router types `httpEffect`, and a generator would lose that.
    return HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest

          if (request.method !== "GET" && request.method !== "HEAD") return yield* httpEffect

          const response = yield* siteResponse(override, request.url)

          return response ?? (yield* httpEffect)
        }),
      { global: true }
    )
  })
)
