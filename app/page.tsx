import { auth } from "@/auth";
import CoPilot from "./components/CoPilot";

export default async function Home() {
  // Middleware already protects this route, so session is guaranteed —
  // but we fetch it here to pass user info (avatar + name) down into the
  // sidebar so the AE sees whose session is live and can sign out.
  const session = await auth();
  return (
    <CoPilot
      user={
        session?.user
          ? {
              name: session.user.name ?? null,
              email: session.user.email ?? null,
              image: session.user.image ?? null,
            }
          : null
      }
    />
  );
}
