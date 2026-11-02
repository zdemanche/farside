/** Product key, repo and address as agreed in the proposal. Final names wait on D2 and D5. */

export const PRODUCT_KEY = "farside";
export const PRODUCT_DISPLAY_NAME = "Farside";
export const IAC_HUB_PRODUCT_KEY = "Farside";
export const DEPLOYMENT_KEY = "farside";

/** Proposed Moonaan org repo after D2/D5. This working repo is zdemanche/farside. */
export const AGREED_REPO = "Moonaan/moonaan-farside";
export const WORKING_REPO = "zdemanche/farside";

export const ADDRESS_PATTERN = "farside.<customer>.moonaan.com";

export function customerAddress(customerName: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(customerName)) {
    throw new Error(`customerName ${customerName} is not a Moonaan tenant slug`);
  }
  return `farside.${customerName}.moonaan.com`;
}

export const HEALTH_PATH = "/health";
