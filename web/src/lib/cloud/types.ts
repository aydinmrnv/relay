/**
 * What the browser and the server say to each other about accounts. Kept
 * free of server imports so client code can use it.
 */

/** What this deployment supports, decided on the server from its environment. */
export interface AuthCapabilities {
  enabled: boolean;
  /**
   * Whether the studio opens without an account: only a development copy
   * without accounts. Everywhere else the studio needs a sign-in.
   */
  guests: boolean;
  /** Why accounts are off, shown only in development. */
  reason: string | null;
  /** The Relay Cloud hub signed-in people can run on, when this deployment has one. */
  cloudHub?: string | null;
}

export const NO_ACCOUNTS: AuthCapabilities = { enabled: false, guests: false, reason: null, cloudHub: null };

export interface AccountUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
}

/** The onboarding answers, kept so the studio can tailor what it suggests. */
export interface OnboardingAnswers {
  role?: string;
  sources?: string[];
  destinations?: string[];
  agents?: string;
  review?: string;
  repository?: string;
  firstWorkflow?: string;
}

export interface VersionSummary {
  id: string;
  label: string | null;
  auto: boolean;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
}

export interface ShareSummary {
  slug: string;
  views: number;
  remixes: number;
  createdAt: string;
  updatedAt: string;
}
