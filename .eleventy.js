module.exports = function(eleventyConfig) {
  // Tell Eleventy to copy your SVG logo and icons from the new frontend folder to the output folder
  eleventyConfig.addPassthroughCopy("frontend/*.svg");

  return {
    dir: {
      input: "frontend", // Pointing directly to our new subfolder!
      output: "_site"
    }
  };
};