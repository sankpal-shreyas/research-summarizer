import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as logs from "aws-cdk-lib/aws-logs";

interface ApiStackProps extends cdk.StackProps {
  userPool: cognito.UserPool;
  table: dynamodb.Table;
  jobsQueue: sqs.Queue;
  pdfBucket: import("aws-cdk-lib/aws-s3").IBucket;
}

/**
 * Public REST API.
 *
 * Phase 1 scope (walking skeleton):
 *   GET /health  →  healthFn  (stub, returns { status: "ok", userId })
 *
 * Phase 2+ adds /search, /summarize, /summaries/{jobId} handlers.
 *
 * Authentication: every route is protected by a Cognito JWT authorizer
 * configured on the API Gateway. Our Lambdas never see unauthenticated
 * traffic.
 */
export class ApiStack extends cdk.Stack {
  public readonly apiEndpoint: string;
  public readonly apiName: string = "research-summarizer-api";
  public readonly handlerFns: lambda.IFunction[] = [];

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // Phase 1 stub — returns the authenticated user's id so we can verify
    // the auth flow end-to-end before implementing real handlers.
    const healthFn = new lambda.Function(this, "HealthFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          const claims = event?.requestContext?.authorizer?.claims ?? {};
          return {
            statusCode: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
            body: JSON.stringify({
              status: "ok",
              userId: claims.sub ?? null,
              email: claims.email ?? null,
              now: new Date().toISOString(),
            }),
          };
        };
      `),
      environment: {
        TABLE_NAME: props.table.tableName,
        JOBS_QUEUE_URL: props.jobsQueue.queueUrl,
      },
    });

    const api = new apigw.RestApi(this, "Api", {
      restApiName: "research-summarizer-api",
      deployOptions: {
        stageName: "v1",
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, "JwtAuthorizer", {
      cognitoUserPools: [props.userPool],
    });

    const authProps: apigw.MethodOptions = {
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };

    api.root
      .addResource("health")
      .addMethod("GET", new apigw.LambdaIntegration(healthFn), authProps);

    // Phase 2: search handler — calls arXiv API, returns Paper[]
    const apiRoot = path.join(__dirname, "..", "..", "apps", "api");
    const searchFn = new nodejs.NodejsFunction(this, "SearchFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(apiRoot, "handlers", "search.ts"),
      handler: "handler",
      projectRoot: apiRoot,
      depsLockFilePath: path.join(apiRoot, "package-lock.json"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      bundling: {
        // fast-xml-parser is the only runtime dep; bundle it.
        externalModules: ["@aws-sdk/*"],
        minify: true,
      },
    });

    api.root
      .addResource("search")
      .addMethod("GET", new apigw.LambdaIntegration(searchFn), authProps);

    // Phase 3: job submission, retrieval, listing.
    const handlerProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      projectRoot: apiRoot,
      depsLockFilePath: path.join(apiRoot, "package-lock.json"),
      handler: "handler",
      bundling: { externalModules: ["@aws-sdk/*"], minify: true },
      environment: {
        TABLE_NAME: props.table.tableName,
        JOBS_QUEUE_URL: props.jobsQueue.queueUrl,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    } satisfies Partial<nodejs.NodejsFunctionProps>;

    const submitJobFn = new nodejs.NodejsFunction(this, "SubmitJobFn", {
      ...handlerProps,
      entry: path.join(apiRoot, "handlers", "submit-job.ts"),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
    });
    props.table.grantReadWriteData(submitJobFn);
    props.jobsQueue.grantSendMessages(submitJobFn);

    const getSummaryFn = new nodejs.NodejsFunction(this, "GetSummaryFn", {
      ...handlerProps,
      entry: path.join(apiRoot, "handlers", "get-summary.ts"),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
    });
    props.table.grantReadData(getSummaryFn);

    const listSummariesFn = new nodejs.NodejsFunction(this, "ListSummariesFn", {
      ...handlerProps,
      entry: path.join(apiRoot, "handlers", "list-summaries.ts"),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
    });
    props.table.grantReadData(listSummariesFn);

    const getQuotaFn = new nodejs.NodejsFunction(this, "GetQuotaFn", {
      ...handlerProps,
      entry: path.join(apiRoot, "handlers", "get-quota.ts"),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
    });
    props.table.grantReadData(getQuotaFn);

    // Knowledge graph — extracts entities + relationships from the
    // structured summary via Bedrock; lazily generated and cached on the
    // JOB record.
    const getGraphFn = new nodejs.NodejsFunction(this, "GetGraphFn", {
      ...handlerProps,
      entry: path.join(apiRoot, "handlers", "get-graph.ts"),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ...handlerProps.environment,
        BEDROCK_MODEL_ID: "us.anthropic.claude-sonnet-4-6",
      },
    });
    props.table.grantReadWriteData(getGraphFn);
    getGraphFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*",
      ],
    }));

    // Related papers — computes cosine similarity of the target paper's
    // mean embedding against every other DONE summary the user owns.
    const getRelatedFn = new nodejs.NodejsFunction(this, "GetRelatedFn", {
      ...handlerProps,
      entry: path.join(apiRoot, "handlers", "get-related.ts"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });
    props.table.grantReadWriteData(getRelatedFn);
    getRelatedFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*",
      ],
    }));

    // Chat (RAG) handler — reads chunks + embeddings from DDB, embeds the
    // question via Bedrock Titan, ranks chunks, prompts the LLM.
    const chatFn = new nodejs.NodejsFunction(this, "ChatFn", {
      ...handlerProps,
      entry: path.join(apiRoot, "handlers", "chat.ts"),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ...handlerProps.environment,
        PDF_BUCKET: props.pdfBucket.bucketName,
        BEDROCK_MODEL_ID: "us.anthropic.claude-sonnet-4-6",
      },
    });
    props.table.grantReadWriteData(chatFn);
    props.pdfBucket.grantRead(chatFn);
    chatFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*",
      ],
    }));

    // Pre-signed PUT URL for direct browser → S3 upload of user PDFs.
    // Uploaded objects land at uploads/{userId}/{paperId}.pdf and are picked
    // up by the pipeline via the `internal:` pdfUrl scheme (see fetch-pdf.ts).
    const getUploadUrlFn = new nodejs.NodejsFunction(this, "GetUploadUrlFn", {
      ...handlerProps,
      entry: path.join(apiRoot, "handlers", "get-upload-url.ts"),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: {
        ...handlerProps.environment,
        PDF_BUCKET: props.pdfBucket.bucketName,
      },
    });
    props.pdfBucket.grantPut(getUploadUrlFn, "uploads/*");
    props.pdfBucket.grantRead(getUploadUrlFn, "uploads/*");

    const summarize = api.root.addResource("summarize");
    summarize.addMethod("POST", new apigw.LambdaIntegration(submitJobFn), authProps);

    api.root
      .addResource("upload-url")
      .addMethod("POST", new apigw.LambdaIntegration(getUploadUrlFn), authProps);

    const summaries = api.root.addResource("summaries");
    summaries.addMethod("GET", new apigw.LambdaIntegration(listSummariesFn), authProps);

    const summaryById = summaries.addResource("{id}");
    summaryById.addMethod("GET", new apigw.LambdaIntegration(getSummaryFn), authProps);
    summaryById.addResource("related").addMethod("GET", new apigw.LambdaIntegration(getRelatedFn), authProps);
    summaryById.addResource("graph").addMethod("GET", new apigw.LambdaIntegration(getGraphFn), authProps);

    api.root.addResource("quota").addMethod("GET", new apigw.LambdaIntegration(getQuotaFn), authProps);
    api.root.addResource("chat").addMethod("POST", new apigw.LambdaIntegration(chatFn), authProps);

    this.apiEndpoint = api.url;
    this.handlerFns.push(healthFn, searchFn, submitJobFn, getSummaryFn, listSummariesFn, getQuotaFn, getRelatedFn, getGraphFn, chatFn, getUploadUrlFn);
    // Active X-Ray tracing + IAM permission so the Lambda runtime can
    // actually write trace segments.
    this.handlerFns.forEach((fn) => {
      const concrete = fn as lambda.Function;
      const cfn = concrete.node.defaultChild as lambda.CfnFunction | undefined;
      if (cfn) cfn.tracingConfig = { mode: "Active" };
      concrete.role?.addManagedPolicy(
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"),
      );
    });
    new cdk.CfnOutput(this, "ApiEndpoint", { value: api.url });
  }
}
