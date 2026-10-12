const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");

// If explicit keys are set (e.g. hosting outside AWS like Render) use them;
// otherwise fall back to the default AWS credential chain (IAM role on
// App Runner / EC2 / Lambda, or ~/.aws/credentials locally).
const hasStaticKeys =
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "ap-south-1",
  // Optional: point at DynamoDB Local / dynalite for local development & tests
  ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
  ...(hasStaticKeys && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  }),
});

const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

module.exports = { client, docClient };
