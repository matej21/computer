import { DurableObject } from "cloudflare:workers";

export interface MacroBenchBindings {
  NEXTJS_BENCH_COMMIT: string;
  NEXTJS_BENCH_PACKED_ONLY: string;
  NEXTJS_BENCH_REF: string;
  NEXTJS_BENCH_URL: string;
  NEXTJS_MACRO_DO: DurableObjectNamespace;
}

export class NextjsMacroDO extends DurableObject<MacroBenchBindings> {}

export default {
  async fetch(): Promise<Response> {
    return new Response("Next.js macro benchmark");
  },
} satisfies ExportedHandler<MacroBenchBindings>;
