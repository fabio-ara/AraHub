/** Public presentation settings. Supabase Auth remains the registration authority. */
export type LoginConfig = {
  registration: "invite" | "open";
  emailLink: boolean;
  password: boolean;
  providers: ("google" | "github" | "azure")[];
};

export const DEFAULT_LOGIN: LoginConfig = {
  registration: "invite",
  emailLink: true,
  password: false,
  providers: [],
};

export function loginConfig(read: (name: string) => string | undefined): LoginConfig {
  const registration = read("ARAHUB_REGISTRATION") ?? "invite";
  if (registration !== "invite" && registration !== "open") {
    throw new Error("ARAHUB_REGISTRATION deve ser invite ou open.");
  }
  const flag = (name: string, fallback: boolean) => {
    const value = read(name);
    if (value === undefined) return fallback;
    if (value !== "true" && value !== "false") throw new Error(`${name} deve ser true ou false.`);
    return value === "true";
  };
  const providers = [
    ...new Set(
      (read("ARAHUB_LOGIN_PROVIDERS") ?? "").split(",")
        .map((v) => v.trim()).filter(Boolean),
    ),
  ];
  if (providers.some((p) => !["google", "github", "azure"].includes(p))) {
    throw new Error("ARAHUB_LOGIN_PROVIDERS aceita google,github,azure.");
  }
  const result: LoginConfig = {
    registration,
    emailLink: flag("ARAHUB_LOGIN_EMAIL_LINK", true),
    password: flag("ARAHUB_LOGIN_PASSWORD", false),
    providers: providers as LoginConfig["providers"],
  };
  if (!result.emailLink && !result.password && !result.providers.length) {
    throw new Error("Configure pelo menos uma forma de entrada no AraHub.");
  }
  return result;
}
