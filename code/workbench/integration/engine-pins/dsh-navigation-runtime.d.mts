export interface DshNavigationProof {
  capabilityVersion: 1; origin: string; pid: number; childPid: number; home: string;
  inventorySha256: string; clientSha256: string; servedSha256: string; moduleRevision: string;
  authenticatedIndexVerified: true; actualServedBytesVerified: true;
}
export function verifyDshNavigationRuntime(projectRoot: string, expectedOrigin: string): Promise<DshNavigationProof>;
