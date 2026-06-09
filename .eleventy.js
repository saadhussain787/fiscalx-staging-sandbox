module.exports = function(eleventyConfig) {
  // Tell Eleventy to copy your SVG logo and icons directly to the output folder
  eleventyConfig.addPassthroughCopy("*.svg");

  return {
    dir: {
      input: ".",
      output: "_site"
    }
  };
};