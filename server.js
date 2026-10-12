require("dotenv").config();

const app = require("./src/app");
const logger = require("./src/utils/logger");

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  logger.info(`shop-caller-backend listening on port ${PORT}`);
});
