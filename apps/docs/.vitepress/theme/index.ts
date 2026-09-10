import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import HeroApyChart from "./HeroApyChart.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "home-hero-image": () => h(HeroApyChart),
    });
  },
};
