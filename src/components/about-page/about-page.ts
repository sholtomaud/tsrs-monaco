import { BaseComponent } from '../../core/base-component.ts';
import template from './about-page.html?raw';
import style from './about-page.css?raw';

export class AboutComponent extends BaseComponent {
  static tagName = 'about-page';

  constructor() {
    super(template, style);
  }

  init() {}
}

if (!customElements.get(AboutComponent.tagName)) {
  customElements.define(AboutComponent.tagName, AboutComponent);
}
