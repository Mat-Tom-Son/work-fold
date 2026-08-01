import identity from "./product-identity.json" with { type: "json" };

export const productIdentity = Object.freeze(identity);

export type ProductIdentity = typeof productIdentity;
