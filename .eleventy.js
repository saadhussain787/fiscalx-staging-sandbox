module.exports = function(eleventyConfig) {
  // Tell Eleventy to copy images, icons, and videos from the frontend folder to the output folder
  eleventyConfig.addPassthroughCopy("frontend/*.svg");
  eleventyConfig.addPassthroughCopy("frontend/*.mp4");
  eleventyConfig.addPassthroughCopy("frontend/*.webp");
  eleventyConfig.addPassthroughCopy("frontend/*.jpg");
  eleventyConfig.addPassthroughCopy("frontend/*.png");

  return {
    dir: {
      input: "frontend", // Pointing directly to our new subfolder!
      output: "_site"
    }
  };
};