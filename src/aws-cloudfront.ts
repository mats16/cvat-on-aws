import * as cdk from 'aws-cdk-lib';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import { LoadBalancerV2Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

interface CloudFrontProps {
  originLoadBalancer: elb.ILoadBalancerV2;
}

export class CloudFront extends Construct {
  distribution: cf.IDistribution;

  constructor(scope: Construct, id: string, props: CloudFrontProps) {
    super(scope, id);

    const origin = new LoadBalancerV2Origin(props.originLoadBalancer, { protocolPolicy: cf.OriginProtocolPolicy.HTTP_ONLY });

    const cachePolicy = new cf.CachePolicy(this, 'CachePolicy', {
      cachePolicyName: `${cdk.Aws.STACK_NAME}-${id}-CachePolicy-${cdk.Aws.REGION}`,
      comment: `${this.node.path}/CachePolicy`,
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(3600),
      defaultTtl: cdk.Duration.seconds(0),
      headerBehavior: cf.CacheHeaderBehavior.allowList('authorization'),
      queryStringBehavior: cf.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const defaultBehavior: cf.BehaviorOptions = {
      viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cf.AllowedMethods.ALLOW_ALL,
      cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
      originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER,
      origin,
    };

    const apiBehavior: cf.BehaviorOptions = {
      viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cf.AllowedMethods.ALLOW_ALL,
      cachePolicy,
      originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER,
      origin,
    };

    this.distribution = new cf.Distribution(this, 'Distribution', {
      httpVersion: cf.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      comment: `${this.node.path}/Distribution`,
      defaultBehavior,
      additionalBehaviors: {
        '/api/*': apiBehavior,
        '/git/*': apiBehavior,
        '/opencv/*': apiBehavior,
        '/analytics/*': apiBehavior,
        '/admin*': apiBehavior,
        '/documentation/*': apiBehavior,
        '/django-rq*': apiBehavior,
      },
    });

  }
}
