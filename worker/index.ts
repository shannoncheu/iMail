/** Cloudflare Worker entry point used by the hosted mock preview. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  runMaintenanceCleanup,
  type MaintenanceCleanupOptions,
  type MaintenanceCleanupResult,
} from "../src/server/maintenance";
import { runWithRuntimeEnv, type RuntimeEnv } from "../src/server/runtime-env";
import { applySecurityHeaders } from "../src/server/security/response-headers";

interface Env extends RuntimeEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  cron: string;
  scheduledTime: number;
  noRetry(): void;
}

type MaintenanceCleanup = (
  options: Omit<MaintenanceCleanupOptions, "repository">,
) => Promise<MaintenanceCleanupResult>;

interface WorkerDependencies {
  maintenanceCleanup?: MaintenanceCleanup;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

export async function runScheduledMaintenance(
  env: RuntimeEnv,
  scheduledTime: number,
  cleanup: MaintenanceCleanup = runMaintenanceCleanup,
): Promise<MaintenanceCleanupResult> {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("Scheduled maintenance requires DATABASE_URL");
  }

  const now = new Date(scheduledTime);
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Scheduled maintenance time must be valid");
  }

  return runWithRuntimeEnv(env, () => cleanup({ databaseUrl, now }));
}

export function createWorker(dependencies: WorkerDependencies = {}) {
  const maintenanceCleanup =
    dependencies.maintenanceCleanup ?? runMaintenanceCleanup;

  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/_vinext/image") {
        const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
        const response = await handleImageOptimization(
          request,
          {
            fetchAsset: (path) =>
              env.ASSETS.fetch(new Request(new URL(path, request.url))),
            transformImage: async (body, { width, format, quality }) => {
              const result = await env.IMAGES.input(body)
                .transform(width > 0 ? { width } : {})
                .output({ format, quality });
              return result.response();
            },
          },
          allowedWidths,
        );
        return applySecurityHeaders(response, request.url);
      }

      const response = await runWithRuntimeEnv(env, () =>
        handler.fetch(request, env, ctx),
      );
      return applySecurityHeaders(response, request.url);
    },

    scheduled(
      controller: ScheduledController,
      env: Env,
      ctx: ExecutionContext,
    ): void {
      ctx.waitUntil(
        runScheduledMaintenance(
          env,
          controller.scheduledTime,
          maintenanceCleanup,
        ).then(
          (result) => {
            console.info(
              JSON.stringify({
                event: "imail.maintenance.completed",
                ...result,
              }),
            );
            return result;
          },
          (error: unknown) => {
            console.error(
              JSON.stringify({ event: "imail.maintenance.failed" }),
            );
            throw error;
          },
        ),
      );
    },
  };
}

export default createWorker();
