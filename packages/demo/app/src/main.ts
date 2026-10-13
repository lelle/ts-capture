import { itemCount, parseOrder, receiptText, submitOrder } from "./order";

const form = document.querySelector<HTMLFormElement>("#order")!;
const button = form.querySelector<HTMLButtonElement>("button")!;
const receiptLine = document.querySelector<HTMLParagraphElement>("#receipt")!;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const order = parseOrder(form);
  button.textContent = `Sending ${itemCount(order)} items…`;
  const receipt = await submitOrder(order);
  receiptLine.textContent = receiptText(receipt);
  receiptLine.hidden = false;
  button.textContent = "Place order";
});
