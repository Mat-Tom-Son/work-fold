import type { IncludedToolId } from "../../../../src/shared/included-tools";

/**
 * Icons for the five tools that ship with work-fold. Chrome, Computer Control,
 * Web and Documents are Arcticons (CC BY-SA 4.0, https://arcticons.com); the
 * Service Connections mark is the MCP logo from Boxicons (CC BY 4.0).
 */
export function IncludedToolIcon({ id, size = 20 }: { id: IncludedToolId; size?: number }) {
  const line = { fill: "none", stroke: "currentColor", strokeWidth: 2.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const frame = { width: size, height: size, "aria-hidden": true as const, focusable: "false" as const };
  switch (id) {
    case "chrome":
      return (
        <svg viewBox="0 0 48 48" {...frame}>
          <circle cx="24" cy="24" r="21.5" {...line} />
          <circle cx="24.18" cy="24.02" r="9" {...line} />
          <path {...line} d="M24.18 15.02h19.36m-27.154 13.5l-9.68-16.766M31.974 28.52l-9.68 16.766" />
        </svg>
      );
    case "computer":
      return (
        <svg viewBox="0 0 48 48" {...frame}>
          <path {...line} d="M39.571 33.53H8.43a2.93 2.93 0 0 1-2.93-2.927V10.475a2.93 2.93 0 0 1 2.929-2.928H39.57a2.93 2.93 0 0 1 2.93 2.928v20.128a2.93 2.93 0 0 1-2.93 2.927m-11.585 0v2.86c0 2.861 5.14 4.063 5.14 4.063h-18.25s5.102-1.202 5.102-4.062v-2.86M5.5 29.2h37" />
        </svg>
      );
    case "web":
      return (
        <svg viewBox="0 0 48 48" {...frame}>
          <path {...line} d="M24.04 42.5c10.215 0 18.46-8.285 18.46-18.54c0-10.215-8.245-18.46-18.46-18.46C13.785 5.5 5.5 13.745 5.5 23.96c0 10.255 8.285 18.54 18.54 18.54m16.012-27.75H7.96m32.195 18.275H7.857M5.6 24h36.8M24.04 5.5v37" />
          <path {...line} d="M24.02 42.5c5.108 0 9.23-8.285 9.23-18.54c0-10.215-4.122-18.46-9.23-18.46c-5.128 0-9.27 8.245-9.27 18.46c0 10.255 4.142 18.54 9.27 18.54" />
        </svg>
      );
    case "documents":
      return (
        <svg viewBox="0 0 48 48" {...frame}>
          <path {...line} d="M10.364 4.51a1.994 1.994 0 0 0-1.945 1.994v35.002a1.995 1.995 0 0 0 1.944 1.994h27.224a1.994 1.994 0 0 0 1.994-1.994V14.472h-7.977a1.995 1.995 0 0 1-1.945-1.995V4.5Zm19.205 0l9.962 9.962m-23.693 8.456h16.274M15.838 34.994h16.274m-16.274-6.033h16.274" />
        </svg>
      );
    case "mcp":
      return (
        <svg viewBox="0 0 24 24" {...frame}>
          <path fill="currentColor" d="M19.97 11.84c.66-.66 1.02-1.53 1.02-2.46s-.36-1.8-1.02-2.46l-.04-.04a3.45 3.45 0 0 0-2.46-1.02c-.17 0-.34.03-.51.05c.02-.17.05-.33.05-.51c0-.93-.36-1.8-1.02-2.46s-1.53-1.02-2.46-1.02s-1.8.36-2.46 1.02L3.2 10.81a.694.694 0 0 0 .98.98l7.87-7.87c.39-.39.92-.61 1.47-.61A2.08 2.08 0 0 1 15.6 5.4c0 .56-.22 1.08-.61 1.48l-5.86 5.86l-.08.08c-.27.27-.27.71 0 .98c.14.14.31.2.49.2s.36-.07.49-.2l5.94-5.94a2.09 2.09 0 0 1 2.95 0l.04.04c.39.39.61.92.61 1.47s-.22 1.08-.61 1.48l-7.11 7.11c-.63.63-.63 1.66 0 2.29l1.46 1.46c.14.14.31.2.49.2s.36-.07.49-.2c.27-.27.27-.71 0-.98l-1.46-1.46a.235.235 0 0 1 0-.33l7.11-7.11Z" />
          <path fill="currentColor" d="M17.96 9.83a.694.694 0 0 0-.98-.98l-5.82 5.82c-.81.81-2.14.81-2.95 0s-.81-2.14 0-2.95l5.82-5.82a.694.694 0 0 0-.98-.98l-5.82 5.82a3.476 3.476 0 0 0 0 4.92c.68.68 1.57 1.02 2.46 1.02s1.78-.34 2.46-1.02l5.82-5.82Z" />
        </svg>
      );
  }
}
