import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "./middleware";
import { clearKey, licenseStatus, saveKey } from "./license";

/**
 * Keys are verified against a public key compiled into the app, so none of
 * these procedures reach the network.
 */
export const licenseRouter = createRouter({
  status: publicQuery.query(() => licenseStatus()),

  activate: publicQuery
    .input(z.object({ key: z.string().min(1).max(4096) }))
    .mutation(({ input }) => {
      if (!saveKey(input.key)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That key is not valid for this app.",
        });
      }
      return licenseStatus();
    }),

  deactivate: publicQuery.mutation(() => {
    clearKey();
    return licenseStatus();
  }),
});
