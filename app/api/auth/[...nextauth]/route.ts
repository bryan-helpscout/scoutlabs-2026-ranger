/**
 * Auth.js v5 dynamic route — handles every step of the OAuth lifecycle:
 * sign-in, OAuth callback, sign-out, CSRF token, session endpoint.
 *
 * See auth.ts at the project root for the actual provider configuration.
 */
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
