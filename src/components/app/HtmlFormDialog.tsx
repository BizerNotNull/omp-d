import { createElement, Fragment, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DialogRequest } from "@/lib/omp/store";

type FormDataValues = Record<string, string | number | string[]>;
type ChoiceGroup = { name: string; type: "radio" | "checkbox"; inputs: HTMLInputElement[]; other: boolean; anchor: Element };

const svgTags = new Set("svg g path circle ellipse rect line polyline polygon text tspan title desc defs marker".split(" "));
const tags = new Set("p div span fieldset legend label input textarea select option optgroup strong em b i small code pre ul ol li br hr table thead tbody tr th td h1 h2 h3 h4 blockquote img".split(" "));
const blocked = new Set("script style iframe object embed link meta base template math button foreignObject use image".split(" "));
const inputTypes = new Set("text number range date datetime-local time month week email url tel password search color hidden radio checkbox".split(" "));
const attributes: Record<string, string> = {
  name: "name", placeholder: "placeholder", min: "min", max: "max", step: "step", pattern: "pattern",
  minlength: "minLength", maxlength: "maxLength", rows: "rows", cols: "cols", title: "title",
  alt: "alt", width: "width", height: "height", colspan: "colSpan", rowspan: "rowSpan", label: "label",
  "aria-label": "aria-label", "aria-describedby": "aria-describedby",
};
const svgAttributes: Record<string, string> = {
  viewBox: "viewBox", x: "x", y: "y", x1: "x1", y1: "y1", x2: "x2", y2: "y2",
  width: "width", height: "height", cx: "cx", cy: "cy", r: "r", rx: "rx", ry: "ry",
  d: "d", points: "points", transform: "transform", "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap", "stroke-linejoin": "strokeLinejoin",
  "font-size": "fontSize", "text-anchor": "textAnchor", "dominant-baseline": "dominantBaseline",
};

function parseForm(html: string) {
  // Parse inertly, then rebuild only known elements and attributes. Never mount model HTML.
  const template = document.createElement("template");
  template.innerHTML = html;
  const form = template.content.querySelector("form");
  const groups = new Map<string, ChoiceGroup>();
  for (const input of form?.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]') ?? []) {
    if (!input.name) continue;
    const key = `${input.type}\0${input.name}`;
    const group = groups.get(key) ?? { name: input.name, type: input.type as ChoiceGroup["type"], inputs: [], other: false, anchor: input };
    group.inputs.push(input);
    group.anchor = input.closest("label") ?? input;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.other = group.inputs.length > 1 && !group.inputs.some((input) => /^\s*other\b/i.test(input.labels?.[0]?.textContent ?? input.value));
  }
  return { form, groups: [...groups.values()] };
}

export function HtmlFormDialog({ dialog, onAnswer, onCancel }: {
  dialog: Extract<DialogRequest, { method: "form" }>;
  onAnswer: (id: string, response: { data: FormDataValues }) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}) {
  const parsed = useMemo(() => parseForm(dialog.html), [dialog.html]);
  const prefix = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [otherSelected, setOtherSelected] = useState<Set<string>>(() => new Set());
  const otherValues = useRef(new Map<string, string>());
  const [error, setError] = useState<string>();

  function collect(form: HTMLFormElement): FormDataValues {
    const entries = new FormData(form);
    const data: FormDataValues = Object.create(null);
    const controls = Array.from(form.elements).filter((control): control is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
      control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement);
    for (const name of new Set(controls.map((control) => control.name).filter(Boolean))) {
      const fields = controls.filter((control) => control.name === name);
      const values = entries.getAll(name).map(String).map((value) =>
        value === prefix ? otherValues.current.get(name)?.trim() ?? "" : value);
      const group = parsed.groups.find((entry) => entry.name === name);
      const select = fields.find((field) => field instanceof HTMLSelectElement);
      const array = (group?.type === "checkbox" && group.inputs.length > 1)
        || (select instanceof HTMLSelectElement && select.multiple && select.options.length > 1);
      if (array) data[name] = [...new Set(values)];
      else if (values.length) {
        const numeric = fields.some((field) => field instanceof HTMLInputElement && ["number", "range"].includes(field.type));
        data[name] = numeric && values[0] !== "" ? Number(values[0]) : values[0];
      }
    }
    return data;
  }

  function submit(form: HTMLFormElement) {
    const data = collect(form);
    for (const group of parsed.groups) {
      const value = data[group.name];
      if (group.inputs.some((input) => input.required) && (value === undefined || value === "" || (Array.isArray(value) && value.length === 0))) {
        setError(`Choose an answer for ${group.name}.`);
        return;
      }
    }
    setError(undefined);
    void onAnswer(dialog.id, { data });
  }

  function renderOther(group: ChoiceGroup): ReactNode {
    if (!group.other) return null;
    return (
      <div className="mt-2 space-y-1.5">
        <label className="flex items-center gap-2 text-xs">
          <input type={group.type} name={group.name} value={prefix} className="accent-primary" />
          Other
        </label>
        <input
          aria-label={`Other answer for ${group.name}`}
          className="h-8 w-full rounded-md border bg-background px-2 text-xs disabled:opacity-50"
          disabled={!otherSelected.has(group.name)}
          required={otherSelected.has(group.name)}
          onChange={(event) => otherValues.current.set(group.name, event.target.value)}
        />
      </div>
    );
  }

  function render(node: Node, key: string): ReactNode {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (!(node instanceof Element)) return null;
    const tag = node.localName;
    if (blocked.has(tag)) return null;
    const children = () => Array.from(node.childNodes, (child, index) => render(child, `${key}-${index}`));
    if (node.namespaceURI === "http://www.w3.org/2000/svg") {
      if (!svgTags.has(tag)) return null;
      const props: Record<string, unknown> = { key };
      for (const [attribute, prop] of Object.entries(svgAttributes)) {
        if (node.hasAttribute(attribute)) props[prop] = node.getAttribute(attribute);
      }
      for (const attribute of ["fill", "stroke"]) {
        const value = node.getAttribute(attribute);
        if (value && /^(?:none|currentColor|[a-z]+|#[\da-f]{3,8}|var\(--[\w-]+\))$/i.test(value)) props[attribute] = value;
      }
      if (tag === "svg") props.className = "max-h-80 max-w-full";
      return createElement(tag, props, children());
    }
    if (!tags.has(tag)) return <Fragment key={key}>{children()}</Fragment>;
    const props: Record<string, unknown> = { key };
    for (const [attribute, prop] of Object.entries(attributes)) {
      if (node.hasAttribute(attribute)) props[prop] = node.getAttribute(attribute);
    }
    if (node.id) props.id = `${prefix}-${node.id}`;
    if (tag === "label" && node.hasAttribute("for")) props.htmlFor = `${prefix}-${node.getAttribute("for")}`;
    if (["input", "select", "textarea", "option", "optgroup"].includes(tag)) {
      if (node.hasAttribute("disabled")) props.disabled = true;
      // Choice requiredness is per group, not per checkbox; checked in submit().
      if (node.hasAttribute("required") && !(tag === "input" && ["radio", "checkbox"].includes((node as HTMLInputElement).type))) props.required = true;
    }
    let content: ReactNode = children();
    if (tag === "input") {
      const input = node as HTMLInputElement;
      if (!inputTypes.has(input.type) || !input.name) return null;
      props.type = input.type;
      props.defaultValue = input.getAttribute("value") ?? (input.type === "checkbox" || input.type === "radio" ? "on" : "");
      if (["checkbox", "radio"].includes(input.type)) {
        props.defaultChecked = input.checked;
        props.className = "mr-2 accent-primary";
      } else if (input.type !== "hidden") props.className = "w-full rounded-md border bg-background px-2 py-1.5 text-xs";
      content = undefined;
    } else if (tag === "textarea") {
      props.defaultValue = node.textContent ?? "";
      props.className = "min-h-20 w-full rounded-md border bg-background px-2 py-1.5 text-xs";
      content = undefined;
    } else if (tag === "select") {
      const select = node as HTMLSelectElement;
      props.multiple = select.multiple;
      const selected = Array.from(select.options).filter((option) => option.hasAttribute("selected")).map((option) => option.value);
      props.defaultValue = select.multiple ? selected : selected.at(-1) ?? Array.from(select.options).find((option) => !option.disabled)?.value;
      props.className = "w-full rounded-md border bg-background px-2 py-1.5 text-xs";
    } else if (tag === "option") props.value = (node as HTMLOptionElement).value;
    else if (tag === "fieldset") props.className = "space-y-2 rounded-xl border p-3";
    else if (tag === "legend") props.className = "px-1 text-sm font-medium";
    else if (tag === "label") props.className = "block space-y-1 text-xs";
    else if (tag === "pre") props.className = "overflow-x-auto whitespace-pre-wrap rounded-md border p-2 text-xs";
    else if (tag === "table") props.className = "w-full border-collapse text-xs [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2";
    else if (tag === "img") {
      const src = node.getAttribute("src") ?? "";
      if (!/^https?:\/\//i.test(src) && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) return null;
      props.src = src;
      props.referrerPolicy = "no-referrer";
      props.className = "max-h-80 max-w-full object-contain";
      content = undefined;
    } else if (tag === "br" || tag === "hr") content = undefined;
    const element = createElement(tag, props, content);
    const group = parsed.groups.find((entry) => entry.anchor === node);
    return group?.other ? <Fragment key={key}>{element}{renderOther(group)}</Fragment> : element;
  }

  return (
    <form
      ref={formRef}
      className="space-y-3"
      onChange={() => {
        const data = new FormData(formRef.current!);
        setOtherSelected(new Set(parsed.groups.filter((group) => data.getAll(group.name).includes(prefix)).map((group) => group.name)));
      }}
      onSubmit={(event) => { event.preventDefault(); submit(event.currentTarget); }}
    >
      <h2 className="flex items-center gap-2 text-sm font-medium"><HelpCircle className="size-4 text-muted-foreground" />A question from the agent</h2>
      <div className="space-y-3 text-xs leading-relaxed">{parsed.form ? Array.from(parsed.form.childNodes, (node, index) => render(node, String(index))) : "The agent supplied no form."}</div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => void onCancel(dialog.id)}>Cancel</Button>
        <Button type="submit" disabled={!parsed.form}>Send answers</Button>
      </div>
    </form>
  );
}
