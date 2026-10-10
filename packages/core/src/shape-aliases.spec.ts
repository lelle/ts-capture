import { describe, expect, it } from "vitest";

import { planShapeAliases } from "./shape-aliases.js";

const PRODUCT = "{ name: string, price: number, sku: string }";
const CUSTOMER = "{ email: string, name: string }";
const free = (): boolean => false;

describe("planShapeAliases", () => {
  it("names a shape two sites share after the first site, and declares it once", () => {
    const plan = planShapeAliases(
      [
        { emitted: PRODUCT, name: "product" },
        { emitted: PRODUCT, name: "item" },
      ],
      free,
    );
    expect(plan.emitted).toEqual(["Product", "Product"]);
    expect(plan.declarations).toEqual([
      { name: "Product", body: "{ name: string; price: number; sku: string }" },
    ]);
  });

  it("leaves a shape seen once inline", () => {
    const plan = planShapeAliases(
      [
        { emitted: PRODUCT, name: "product" },
        { emitted: CUSTOMER, name: "customer" },
      ],
      free,
    );
    expect(plan.emitted).toEqual([PRODUCT, CUSTOMER]);
    expect(plan.declarations).toEqual([]);
  });

  it("leaves a shape with a single property inline", () => {
    const plan = planShapeAliases(
      [
        { emitted: "{ ok: boolean }", name: "result" },
        { emitted: "{ ok: boolean }", name: "outcome" },
      ],
      free,
    );
    expect(plan.emitted).toEqual(["{ ok: boolean }", "{ ok: boolean }"]);
    expect(plan.declarations).toEqual([]);
  });

  it("treats the same shape spelled in another order as one shape", () => {
    const plan = planShapeAliases(
      [
        { emitted: "{ a: number, b: string }", name: "left" },
        { emitted: "{ b: string, a: number }", name: "right" },
      ],
      free,
    );
    expect(plan.emitted).toEqual(["Left", "Left"]);
  });

  it("names the element of an array after the site in the singular", () => {
    const plan = planShapeAliases(
      [
        { emitted: `${PRODUCT}[]`, name: "products" },
        { emitted: `${PRODUCT}[]`, name: "entries" },
      ],
      free,
    );
    expect(plan.emitted).toEqual(["Product[]", "Product[]"]);
    expect(plan.declarations.map((d) => d.name)).toEqual(["Product"]);
  });

  it("names the element of an array after a site that holds one directly, when there is one", () => {
    const plan = planShapeAliases(
      [
        { emitted: `${PRODUCT}[]`, name: "items" },
        { emitted: PRODUCT, name: "product" },
      ],
      free,
    );
    expect(plan.emitted).toEqual(["Product[]", "Product"]);
  });

  it("names a shape in a union arm after the site", () => {
    const plan = planShapeAliases(
      [
        { emitted: `${PRODUCT}|undefined`, name: "product" },
        { emitted: PRODUCT, name: "item" },
      ],
      free,
    );
    expect(plan.emitted).toEqual(["Product|undefined", "Product"]);
  });

  it("counts a shape nested in another and writes the name there too", () => {
    const order = `{ customer: ${CUSTOMER}, id: string }`;
    const plan = planShapeAliases(
      [
        { emitted: order, name: "order" },
        { emitted: CUSTOMER, name: "customer" },
      ],
      free,
    );
    expect(plan.emitted).toEqual(["{ customer: Customer, id: string }", "Customer"]);
    expect(plan.declarations).toEqual([{ name: "Customer", body: CUSTOMER.replace(",", ";") }]);
  });

  it("names a shape only ever nested after the property that holds it", () => {
    const order = `{ customer: ${CUSTOMER}, id: string }`;
    const plan = planShapeAliases(
      [
        { emitted: order, name: "order" },
        { emitted: order, name: "placed" },
      ],
      free,
    );
    expect(plan.emitted).toEqual(["Order", "Order"]);
    expect(plan.declarations).toEqual([
      { name: "Order", body: "{ customer: Customer; id: string }" },
      { name: "Customer", body: "{ email: string; name: string }" },
    ]);
  });

  it("names an array element only ever nested after its property, in the singular", () => {
    const line = "{ quantity: number, sku: string }";
    const cart = `{ lines: ${line}[], total: number }`;
    const plan = planShapeAliases(
      [
        { emitted: cart, name: "cart" },
        { emitted: cart, name: "basket" },
      ],
      free,
    );
    expect(plan.declarations).toEqual([
      { name: "Cart", body: "{ lines: Line[]; total: number }" },
      { name: "Line", body: "{ quantity: number; sku: string }" },
    ]);
  });

  it("passes over a name that is taken and uses the next site's", () => {
    const plan = planShapeAliases(
      [
        { emitted: PRODUCT, name: "product" },
        { emitted: PRODUCT, name: "item" },
      ],
      (name) => name === "Product",
    );
    expect(plan.emitted).toEqual(["Item", "Item"]);
  });

  it("leaves a shape inline when every name it could take is taken", () => {
    const plan = planShapeAliases(
      [
        { emitted: PRODUCT, name: "product" },
        { emitted: PRODUCT, name: "item" },
      ],
      () => true,
    );
    expect(plan.emitted).toEqual([PRODUCT, PRODUCT]);
    expect(plan.declarations).toEqual([]);
  });

  it("gives one name to one shape", () => {
    const plan = planShapeAliases(
      [
        { emitted: PRODUCT, name: "item" },
        { emitted: PRODUCT, name: "item" },
        { emitted: CUSTOMER, name: "item" },
        { emitted: CUSTOMER, name: "item" },
      ],
      free,
    );
    expect(plan.emitted).toEqual(["Item", "Item", CUSTOMER, CUSTOMER]);
  });

  it("leaves a site with no name out of the naming and in the count", () => {
    const plan = planShapeAliases(
      [{ emitted: PRODUCT }, { emitted: PRODUCT, name: "product" }],
      free,
    );
    expect(plan.emitted).toEqual(["Product", "Product"]);
  });

  it("spells the name as an identifier", () => {
    const plan = planShapeAliases(
      [
        { emitted: PRODUCT, name: "_product" },
        { emitted: PRODUCT, name: "$item" },
      ],
      free,
    );
    expect(plan.emitted).toEqual(["Product", "Product"]);
  });

  it("leaves a site carrying a note alone", () => {
    const noted = `${PRODUCT} /* @ts-capture:shape-capped */`;
    const plan = planShapeAliases(
      [
        { emitted: noted, name: "product" },
        { emitted: PRODUCT, name: "item" },
      ],
      free,
    );
    expect(plan.emitted).toEqual([noted, PRODUCT]);
  });
});
