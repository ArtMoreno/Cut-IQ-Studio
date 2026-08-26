import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { isPro } from "./license";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const createRouter = t.router;
export const publicQuery = t.procedure;

/**
 * Guards the paid surface. The tier is checked on the server rather than in the
 * UI alone, so a hidden button is not the only thing standing between a free
 * install and the Pro features.
 */
export const proProcedure = t.procedure.use(({ next }) => {
  if (!isPro()) {
    throw new TRPCError({
      code: "PAYMENT_REQUIRED",
      message: "This is a Cut IQ Studio Pro feature.",
    });
  }
  return next();
});
