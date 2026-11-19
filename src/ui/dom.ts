type Child = Node | string | null | undefined | false;

export interface ElementProps {
  className?: string;
  text?: string;
  title?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  min?: string;
  max?: string;
  step?: string;
  checked?: boolean;
  disabled?: boolean;
  htmlFor?: string;
  id?: string;
  accept?: string;
  rows?: string;
  on?: Record<string, (event: Event) => void>;
  dataset?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  if (props.type) node.setAttribute('type', props.type);
  if (props.placeholder) node.setAttribute('placeholder', props.placeholder);
  if (props.accept) node.setAttribute('accept', props.accept);
  if (props.rows) node.setAttribute('rows', props.rows);
  if (props.htmlFor && node instanceof HTMLLabelElement) node.htmlFor = props.htmlFor;
  if (props.id) node.id = props.id;
  if (props.value !== undefined) {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      node.value = props.value;
    } else {
      node.setAttribute('value', props.value);
    }
  }
  if (props.min !== undefined) node.setAttribute('min', props.min);
  if (props.max !== undefined) node.setAttribute('max', props.max);
  if (props.step !== undefined) node.setAttribute('step', props.step);
  if (props.checked !== undefined && node instanceof HTMLInputElement) node.checked = props.checked;
  if (props.disabled !== undefined && 'disabled' in node) {
    (node as HTMLButtonElement).disabled = props.disabled;
  }
  if (props.dataset) {
    for (const [key, value] of Object.entries(props.dataset)) node.dataset[key] = value;
  }
  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) {
      node.addEventListener(event, handler);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}
